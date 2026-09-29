# 同步机制端到端验证脚本
#
# ⚠ 会向目标服务写入数据（含整文档 PUT），**必须**指向使用隔离 DATA_DIR 的实例：
#    $env:DATA_DIR='C:\aki\dev\TypeWords\.tmp-verify-data'; pnpm dev
#    pwsh -NoProfile -File test/e2e-sync.ps1                      # 默认 http://localhost:5567
#    pwsh -NoProfile -File test/e2e-sync.ps1 -BaseUrl http://localhost:5568
param([string]$BaseUrl = 'http://localhost:5567')
$ErrorActionPreference = 'Stop'
$base = $BaseUrl
$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, $detail) {
  if ($ok) { $script:pass++; Write-Host ("  PASS  " + $name) }
  else { $script:fail++; Write-Host ("  FAIL  " + $name + "  => " + ($detail | Out-String).Trim()) }
}

function Get-Json([string]$path) {
  return Invoke-RestMethod -Uri ($base + $path) -TimeoutSec 15
}

function Post-Json([string]$path, $body) {
  $json = $body | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri ($base + $path) -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 15
}

function Put-Json([string]$path, $body) {
  $json = $body | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri ($base + $path) -Method Put -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 20
}

Write-Host "`n=== 1. 服务端文档与修订号 ==="
$seedState = @{
  val = @{
    simpleWords = @('a', 'the')
    load        = $false
    word        = @{
      studyIndex = 3
      bookList   = @(
        @{ id = 'wordCollect'; enName = 'wordCollect'; name = '收藏'; system = $true; words = @(); length = 0 },
        @{ id = 'wordWrong'; enName = 'wordWrong'; name = '错词'; system = $true; words = @(); length = 0 },
        @{ id = 'wordKnown'; enName = 'wordKnown'; name = '已掌握'; system = $true; words = @(); length = 0 },
        @{ id = 'nce1'; enName = 'nce1'; name = '新概念1'; custom = $false; words = @(); length = 2000; lastLearnIndex = 0; perDayStudyNumber = 20; complete = $false; statistics = @() }
      )
    }
    article     = @{ studyIndex = -1; bookList = @() }
    fsrsData    = @{}
    noteData    = @{}
  }
  version     = 4
}

$before = Get-Json '/api/data/dict'
Check '首次读取返回 value=null 且 revision=0（区分「服务端无数据」）' ($null -eq $before.value -and $before.revision -eq 0) $before

$seedRes = Put-Json '/api/data/dict' @{ value = ($seedState | ConvertTo-Json -Depth 12 -Compress); label = 'e2e-seed' }
Check 'PUT 整文档写入成功并递增 revision' ($seedRes.ok -eq $true -and $seedRes.revision -ge 1) $seedRes

$afterSeed = Get-Json '/api/data/dict'
Check 'GET 返回 revision 与 value' ($afterSeed.revision -ge 1 -and $afterSeed.value.Length -gt 10) $afterSeed.revision

# setting 文档在全新库里并不存在（Web 端首次打开时会自动播种）；这里显式播种，模拟真实状态
$seedSetting = @{ val = @{ theme = 'auto'; load = $false }; version = 23 }
$settingSeedRes = Put-Json '/api/data/setting' @{ value = ($seedSetting | ConvertTo-Json -Depth 8 -Compress); label = 'e2e-seed-setting' }
Check 'seed setting 文档成功（否则 scope=setting 的提交会返回 409）' ($settingSeedRes.ok -eq $true) $settingSeedRes

Write-Host "`n=== 2. Agent 端点改薄封装后写入 op 日志 ==="
$agentKnown = Post-Json '/api/words/abandon/known' @{}
Check 'Agent 标记已掌握：changed=true 且返回 revision' ($agentKnown.known -eq $true -and $agentKnown.changed -eq $true) $agentKnown

$ops1 = Get-Json '/api/ops?since=0'
Check 'oplog 记录了 word.known.set' (($ops1.ops | Where-Object { $_.kind -eq 'word.known.set' }).Count -ge 1) ($ops1.ops | ForEach-Object { $_.kind })

Write-Host "`n=== 3. 浏览器端 POST /api/ops + 幂等 ==="
$browserOp = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-collect-1'; kind = 'word.collect.set'; payload = @{ word = 'abandon'; value = $true }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $agentKnown.revision; origin = 'browser'; entityKeys = @('word:abandon') })
}
$push1 = Post-Json '/api/ops' $browserOp
Check '浏览器 op 应用成功（changed=true）' ($push1.applied[0].changed -eq $true -and $push1.revision -gt $agentKnown.revision) $push1

$push2 = Post-Json '/api/ops' $browserOp
Check '同一 opId 重复提交幂等（changed=false 且 revision 不增长）' ($push2.applied[0].changed -eq $false -and $push2.revision -eq $push1.revision) $push2

Write-Host "`n=== 4. 按实体的乐观并发（冲突 vs 不冲突） ==="
# 同一文档代内的「过期基准」：先按当前 revision 写入锚点操作，随后仍以该 revision 提交其它操作。
# 整文档替换同样会推进 revision，因此这里以「替换之后」的 revision 作为过期基准。
$revBase = (Get-Json '/api/ops?since=0').revision
$bumpOp = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-bump-1'; kind = 'word.collect.set'; payload = @{ word = 'bump-anchor'; value = $true }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revBase; origin = 'browser'; entityKeys = @('word:bump-anchor') })
}
$bumpRes = Post-Json '/api/ops' $bumpOp
Check '锚点操作应用成功（用于构造过期基准）' ($bumpRes.applied[0].changed -eq $true) $bumpRes

$conflictOp = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-stale-1'; kind = 'word.known.set'; payload = @{ word = 'bump-anchor'; value = $false }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revBase; origin = 'browser'; entityKeys = @('word:bump-anchor') })
}
$conflictRes = Post-Json '/api/ops' $conflictOp
Check '旧基准 + 同一实体 => ENTITY_MODIFIED 冲突（不静默覆盖）' ($conflictRes.conflicts.Count -eq 1 -and $conflictRes.conflicts[0].reason -eq 'ENTITY_MODIFIED') $conflictRes.conflicts

$parallelOp = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-parallel-1'; kind = 'word.known.set'; payload = @{ word = 'zzz-untouched'; value = $true }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revBase; origin = 'browser'; entityKeys = @('word:zzz-untouched') })
}
$parallelRes = Post-Json '/api/ops' $parallelOp
Check '旧基准但实体不相交 => 直接应用（互不阻塞）' ($parallelRes.conflicts.Count -eq 0 -and $parallelRes.applied[0].changed -eq $true) $parallelRes

Write-Host "`n=== 5. 两端同一操作产生同一结果 ==="
# 用当前 revision 作基准（模拟客户端已同步完成后再提交）
$revNow = (Get-Json '/api/ops?since=0').revision
$dupKnown = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-known-dup'; kind = 'word.known.set'; payload = @{ word = 'abandon'; value = $true }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revNow; origin = 'browser'; entityKeys = @('word:abandon') })
}
$dupRes = Post-Json '/api/ops' $dupKnown
Check '浏览器重复 Agent 已经做过的标记 => changed=false（幂等、无副作用）' ($dupRes.applied[0].changed -eq $false -and $dupRes.conflicts.Count -eq 0) $dupRes

# 旧基准 + 同一实体：先冲突，客户端换新基准重试后变为幂等 no-op（自动合并路径）
$stale = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-known-stale'; kind = 'word.known.set'; payload = @{ word = 'abandon'; value = $true }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = 0; origin = 'browser'; entityKeys = @('word:abandon') })
}
$staleRes = Post-Json '/api/ops' $stale
Check '旧基准重复同一意图 => 报冲突（交由客户端重试/选边）' ($staleRes.conflicts.Count -eq 1) $staleRes.conflicts[0].reason

Write-Host "`n=== 6. 增量拉取 ==="
$afterAll = Get-Json '/api/ops?since=0'
$changedCount = ($afterAll.ops | Where-Object { $_.kind -eq 'word.known.set' -or $_.kind -eq 'word.collect.set' }).Count
Check '增量日志包含全部已应用操作' ($changedCount -ge 3) $changedCount
$head = Get-Json ("/api/ops?since=" + $afterAll.revision)
Check 'since=当前 revision 时无增量' ($head.ops.Count -eq 0 -and $head.revision -eq $afterAll.revision) $head

Write-Host "`n=== 7. 统计/进度/笔记操作 ==="
$revNow2 = (Get-Json '/api/ops?since=0').revision
$mixed = @{
  scope = 'dict'
  ops   = @(
    @{ opId = 'e2e-prog-1'; kind = 'dict.progress.set'; payload = @{ list = 'word'; dictKey = 'nce1'; lastLearnIndex = 40; complete = $false }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revNow2; origin = 'browser'; entityKeys = @('dict:word:nce1') },
    @{ opId = 'e2e-stat-1'; kind = 'dict.statistics.push'; payload = @{ list = 'word'; dictKey = 'nce1'; entries = @(@{ id = 'e2e-sess:100:0'; startDate = 100; spend = 60000; total = 20; new = 20; review = 0; wrong = 1 }) }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revNow2; origin = 'browser'; entityKeys = @('dict:word:nce1') },
    @{ opId = 'e2e-note-1'; kind = 'word.note.set'; payload = @{ word = 'Abandon'; note = 'v. 放弃' }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revNow2; origin = 'browser'; entityKeys = @('word:abandon') },
    @{ opId = 'e2e-fsrs-1'; kind = 'word.fsrs.set'; payload = @{ word = 'abandon'; card = @{ due = '2026-10-01T00:00:00.000Z'; reps = 1; state = 1; stability = 1.0; difficulty = 5.0 } }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revNow2; origin = 'browser'; entityKeys = @('word:abandon') }
  )
}
$mixedRes = Post-Json '/api/ops' $mixed
Check '进度/统计/笔记/FSRS 四类操作全部应用' ((($mixedRes.applied | Where-Object { $_.changed -eq $true }).Count -eq 4) -and $mixedRes.conflicts.Count -eq 0) $mixedRes

$dictNow = Get-Json '/api/data/dict'
$doc = ($dictNow.value | ConvertFrom-Json)
$nce1 = $doc.val.word.bookList | Where-Object { $_.id -eq 'nce1' }
$known = $doc.val.word.bookList | Where-Object { $_.id -eq 'wordKnown' }
Check '服务端 doc 中进度已更新' ($nce1.lastLearnIndex -eq 40) $nce1.lastLearnIndex
Check '服务端 doc 中统计已追加（去重后 1 条）' ($nce1.statistics.Count -eq 1) $nce1.statistics.Count
Check '服务端 doc 中笔记按小写 key 存储' ($doc.val.noteData.abandon -eq 'v. 放弃') $doc.val.noteData
Check '服务端 doc 中已掌握标记存在' (($known.words | Where-Object { $_.word -eq 'abandon' }).Count -eq 1) $known.words.Count
Check '服务端 doc 中 FSRS 卡片存在' ($null -ne $doc.val.fsrsData.abandon) ($doc.val.fsrsData | ConvertTo-Json -Compress)

Write-Host "`n=== 8. 幂等重放：整批再提交一次不应产生变化 ==="
$revBeforeReplay = (Get-Json '/api/ops?since=0').revision
$replay = Post-Json '/api/ops' $mixed
$revAfterReplay = (Get-Json '/api/ops?since=0').revision
Check '重放同一批操作：全部 changed=false 且 revision 不变' ((($replay.applied | Where-Object { $_.changed -eq $true }).Count -eq 0) -and $revBeforeReplay -eq $revAfterReplay) $replay

Write-Host "`n=== 9. 练习缓存 LWW（拒绝更旧快照） ==="
$newEnvelope = @{ version = 2; val = @{ marker = 'newer' }; updated_at = '2026-09-29T10:00:00.000Z' }
$r1 = Put-Json '/api/data/practice_word' @{ value = ($newEnvelope | ConvertTo-Json -Depth 8 -Compress) }
Check '写入较新的练习快照 => applied=true' ($r1.applied -eq $true) $r1
$oldEnvelope = @{ version = 2; val = @{ marker = 'older' }; updated_at = '2026-09-29T09:00:00.000Z' }
$r2 = Put-Json '/api/data/practice_word' @{ value = ($oldEnvelope | ConvertTo-Json -Depth 8 -Compress) }
Check '写入较旧的练习快照 => applied=false（不覆盖新进度）' ($r2.applied -eq $false) $r2
$pw = Get-Json '/api/data/practice_word'
Check '服务端仍保存较新的快照' ($pw.value -like '*newer*') $pw.value

Write-Host "`n=== 10. scope 与 kind 必须匹配（防写脏文档） ==="
$revS = (Get-Json '/api/ops?since=0').revision
$wrongScope = @{
  scope = 'dict'
  ops   = @(@{ opId = 'e2e-scope-bad'; kind = 'setting.patch'; payload = @{ theme = 'dark' }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revS; origin = 'agent'; entityKeys = @('setting:theme') })
}
$wrongRes = Post-Json '/api/ops' $wrongScope
Check 'setting.patch 用 scope=dict 提交 => 被拒绝（INVALID_PAYLOAD）' ($wrongRes.conflicts.Count -eq 1 -and $wrongRes.conflicts[0].reason -eq 'INVALID_PAYLOAD') $wrongRes.conflicts
$dictAfterBad = Get-Json '/api/data/dict'
Check 'dict 文档未被写入 theme 字段' ($dictAfterBad.value -notlike '*"theme"*') 'dict 被污染'

$rightScope = @{
  scope = 'setting'
  ops   = @(@{ opId = 'e2e-scope-good'; kind = 'setting.patch'; payload = @{ theme = 'dark' }; clientTs = (Get-Date).ToUniversalTime().ToString('o'); baseRevision = $revS; origin = 'agent'; entityKeys = @('setting:theme') })
}
$rightRes = Post-Json '/api/ops' $rightScope
Check 'setting.patch 用 scope=setting 提交 => 应用成功' (($rightRes.applied[0].changed -eq $true) -and $rightRes.conflicts.Count -eq 0) $rightRes
$settingAfter = Get-Json '/api/data/setting'
Check 'setting 文档已更新为 theme=dark' ($settingAfter.value -like '*"theme": "dark"*' -or $settingAfter.value -like '*"theme":"dark"*') $settingAfter.value

Write-Host "`n=== 11. Agent 只读接口仍可用 ==="
$overview = Get-Json '/api/overview'
Check '/api/overview 正常返回进度' ($overview.initialized -eq $true -and $overview.currentDict.lastLearnIndex -eq 40) $overview.currentDict
$stats = Get-Json '/api/statistics'
Check '/api/statistics 统计到 1 条会话' ($stats.totals.sessions -ge 1) $stats.totals

Write-Host "`n=== 12. 页面可访问（构建期 #shared 解析验证） ==="
try {
  $page = Invoke-WebRequest -Uri ($base + '/words') -TimeoutSec 40 -UseBasicParsing
  Check '/words 返回 200' ($page.StatusCode -eq 200) $page.StatusCode
} catch { Check '/words 返回 200' $false $_.Exception.Message }

Write-Host ""
Write-Host ("RESULT pass=" + $script:pass + " fail=" + $script:fail)
if ($script:fail -gt 0) { exit 1 }
