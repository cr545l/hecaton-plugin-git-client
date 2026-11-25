const path = require('path');

// Include mtimes: porcelain alone cannot detect another edit to a dirty file.
async function buildWorktreeSnapshot(cwd, api, execGit) {
  const result = await execGit({
    program: 'git',
    args: ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    // 스트리밍을 못 쓰는 호스트에서 exec 로 내려갈 때의 마감. 5초로는 status 가 7초를 넘는
    // 저장소에서 한 번도 끝나지 못했다.
    cwd, timeout_ms: 60000,
  });
  if (!result || !result.ok || result.error || result.error_code || result.timed_out
      || (result.exit_code !== undefined && result.exit_code !== 0)) return null;
  const raw = result.stdout || '';
  return raw + '\x1e' + await statDirtyFiles(cwd, api, raw);
}

// status 출력이 변경됐다고 한 파일들의 시각·크기. 스냅샷의 뒷부분이다.
async function statDirtyFiles(cwd, api, raw) {
  const files = new Set();
  const records = raw.split('\0').filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 4) continue;
    if (rec[0] === 'R' || rec[0] === 'C') i++;
    if (rec[1] === ' ') continue;
    const file = rec.substring(3).replace(/\/$/, '');
    if (file) files.add(file);
  }
  const stats = await Promise.all(Array.from(files).sort().map(async file => {
    try {
      const r = await api.fs.stat({ path: path.join(cwd, file) });
      if (r && r.exists) return file + '\t' + (r.is_dir ? 'd' : 'f') + '\t' + (r.mtime_ms || 0) + '\t' + (r.size || 0);
    } catch { /* missing/unreadable entry */ }
    return file + '\tmissing'; // i18n-ok: internal snapshot fingerprint
  }));
  return stats.join('\x1e');
}

// 스냅샷에 실린 변경 파일들이 그때 그대로인지 — git 을 띄우지 않고 시각만 다시 읽는다.
// 이미 변경된 파일이 또 고쳐졌거나 지워진 것은 잡고, 깨끗하던 파일의 첫 수정과 새 파일은
// 못 잡는다(그쪽은 서비스가 드문드문 돌리는 status 가 맡는다, polling-service.js).
async function dirtyFilesUnchanged(cwd, api, snapshot) {
  if (typeof snapshot !== 'string') return false;
  const cut = snapshot.indexOf('\x1e');
  if (cut < 0) return false;
  return await statDirtyFiles(cwd, api, snapshot.slice(0, cut)) === snapshot.slice(cut + 1);
}

module.exports = { buildWorktreeSnapshot, dirtyFilesUnchanged };
