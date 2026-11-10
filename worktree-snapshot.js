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
  return raw + '\x1e' + stats.join('\x1e');
}

module.exports = { buildWorktreeSnapshot };
