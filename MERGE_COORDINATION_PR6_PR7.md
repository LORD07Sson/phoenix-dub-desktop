# Merge Coordination Guide: PR #6 (ffmpeg) + PR #7 (Velopack)

**Status:** PR #6 is **already merged** into `main`. PR #7 (Velopack) must be rebased and updated to account for the merged ffmpeg changes.

---

## Overview

| Component | PR #6 (ffmpeg) | PR #7 (Velopack) |
|-----------|---|---|
| **Installer system** | NSIS (Tauri built-in) | Velopack (custom vpk) |
| **Packaging method** | `bundle.resources` in tauri.conf.json | `pack_dir/` + `vpk pack` |
| **ffmpeg delivery** | Bundled via Tauri's NSIS | Must be manually copied to Velopack pack dir |
| **Status** | ✅ **Merged** | ⏳ **Open, needs update** |

---

## Timeline

1. **PR #6 merged** (2026-09-15 01:53:26 UTC)
   - ffmpeg bundling via Tauri's NSIS installer added to `main`
   - `tauri.conf.json` now has `bundle.resources: { "binaries/ffmpeg.exe": "./" }`
   - CI downloads + verifies ffmpeg SHA256, then `tauri-action` packages it

2. **PR #7 currently open**
   - Replaces NSIS + tauri-action with Velopack
   - **Removes** `bundle.resources` and entire `bundle` section
   - **Problem:** Doesn't account for bundled ffmpeg location/delivery

---

## What Needs to Happen

### Before Merging PR #7

✅ **PR #7 must be updated to:**

1. **Keep ffmpeg download + SHA256 verification** (already in PR #6's CI)
2. **Copy ffmpeg into `pack_dir/` before `vpk pack`** (new Velopack step)
3. **Remove Tauri's `bundle.resources`** (PR #7 already does this)

### File Changes Required in PR #7

#### 1. `.github/workflows/build.yml`

**Current PR #7 (missing ffmpeg step):**
```yaml
- name: cargo build --release
  run: cargo build --release --manifest-path src-tauri/Cargo.toml

- name: Собрать релиз через vpk
  run: |
    set -e
    dotnet tool update -g vpk
    mkdir -p pack_dir
    cp src-tauri/target/release/phoenix-dub-desktop.exe pack_dir/
    # ⚠️ ffmpeg.exe NOT copied here!
    vpk pack ...
```

**Required update:**
```yaml
- name: cargo build --release
  run: cargo build --release --manifest-path src-tauri/Cargo.toml

# ✅ Keep ffmpeg download from PR #6 (unchanged)
- name: Скачать и проверить статичный ffmpeg.exe
  shell: bash
  run: |
    set -e
    url="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-14-13-17/ffmpeg-n9.0.1-29-gad500d59cb-win64-lgpl-9.0.zip"
    expected_sha256="084874559d629b29cea0cae5b4d3cbb8e384d323f4eb3f1835bd9705d83bf58"
    curl -sL --max-time 180 -o ffmpeg.zip "$url"
    actual_sha256=$(sha256sum ffmpeg.zip | cut -d' ' -f1)
    if [ "$actual_sha256" != "$expected_sha256" ]; then
      echo "::error::SHA256 не совпал — ожидали $expected_sha256, получили $actual_sha256"
      exit 1
    fi
    unzip -q ffmpeg.zip -d ffmpeg_extracted
    find ffmpeg_extracted -iname "ffmpeg.exe" -exec cp {} src-tauri/binaries/ffmpeg.exe \;
    rm -rf ffmpeg.zip ffmpeg_extracted
    test -s src-tauri/binaries/ffmpeg.exe || { echo "::error::ffmpeg.exe не найден в архиве"; exit 1; }

- name: Собрать релиз через vpk
  shell: bash
  run: |
    set -e
    dotnet tool update -g vpk
    mkdir -p pack_dir
    cp src-tauri/target/release/phoenix-dub-desktop.exe pack_dir/
    
    # ✅ NEW: Copy ffmpeg into pack_dir for Velopack
    cp src-tauri/binaries/ffmpeg.exe pack_dir/
    
    echo "Автосборка из main (commit ${{ github.sha }})." > release_notes.md
    vpk pack \
      --packId PhoenixDubDesktop \
      --packVersion "${{ env.PKG_VERSION }}" \
      --packDir pack_dir \
      --mainExe phoenix-dub-desktop.exe \
      --packTitle "PHOENIX DUB Desktop" \
      --icon src-tauri/icons/icon.ico \
      --releaseNotes release_notes.md \
      --outputDir release_output
```

**Key addition:** Lines 34-35 copy ffmpeg from `src-tauri/binaries/` to `pack_dir/`

#### 2. `src-tauri/src/audio_qc.rs`

**Status:** Already compatible with PR #7

- PR #6 modified `audio_qc.rs` to:
  - First check for ffmpeg next to the executable
  - Fall back to system PATH if not found
- PR #7 changes nothing here—just ensures ffmpeg is in `pack_dir/` (which Velopack copies to app root)

#### 3. `src-tauri/tauri.conf.json`

**PR #7 already handles this correctly:**
- ✅ Removes `bundle.resources: { "binaries/ffmpeg.exe": "./" }`
- ✅ Sets `bundle.active: false` (Velopack handles packaging)
- ❌ No changes needed beyond what PR #7 already does

---

## Merge Steps (Detailed)

### Step 1: Update PR #7 Description

Add this note to the PR description:

```markdown
## ⚠️ Important: Merges with PR #6 (ffmpeg)

**Status:** PR #6 (ffmpeg bundling) is already merged into `main`.

**Required:** This PR's CI workflow has been updated to:
1. Keep ffmpeg download + SHA256 verification (from PR #6)
2. Copy ffmpeg into `pack_dir/` before `vpk pack` (for Velopack)
3. Remove Tauri's `bundle.resources` (Velopack doesn't use it)

See `MERGE_COORDINATION_PR6_PR7.md` for full details.
```

### Step 2: Update PR #7's `.github/workflows/build.yml`

Add the ffmpeg download step between "cargo build" and "vpk pack":

```bash
# Copy-paste the entire "Скачать и проверить статичный ffmpeg.exe" step from main's build.yml
# Then add this line in the "Собрать релиз через vpk" step:
cp src-tauri/binaries/ffmpeg.exe pack_dir/
```

### Step 3: Create a Pre-Merge Checklist

Before merging PR #7, verify:

- [ ] PR #7's CI workflow includes ffmpeg download step
- [ ] `build.yml` copies `ffmpeg.exe` to `pack_dir/` before `vpk pack`
- [ ] `tauri.conf.json` has `bundle.active: false` (Velopack mode)
- [ ] `src-tauri/Cargo.toml` depends on `velopack = "1.2.0"`, not `tauri-plugin-updater`
- [ ] Local `cargo check` passes
- [ ] ESLint on `dist/app.js` passes (no Tauri plugin references)

### Step 4: Merge PR #7

Once updated:
```bash
# Ensure branch is up-to-date with main (which includes PR #6)
git checkout feat/velopack-updater
git rebase main
# Or fetch latest main changes if testing locally

# After confirming all checks pass, merge via GitHub UI or:
gh pr merge 7 --squash
```

### Step 5: Trigger First Real CI Run

After merge, manually trigger the workflow:
1. Go to **Actions** → **Build desktop client (Tauri + Velopack)**
2. Click **Run workflow** button
3. Select branch: `main`
4. Watch for:
   - ✅ ffmpeg download completes + SHA256 matches
   - ✅ `cargo build --release` succeeds
   - ✅ `vpk pack` creates installer
   - ✅ `vpk upload github` publishes release

---

## Verification Checklist

### Local Testing (Before Merge)

```bash
# 1. Ensure PR #6 is in your branch
git log --oneline | grep -i "ffmpeg"
# Should show: "Встроить ffmpeg в установщик"

# 2. Verify tauri.conf.json structure
jq '.bundle' src-tauri/tauri.conf.json
# Should output: { "active": false, "icon": [...], ... }
# (no "resources" or "windows.nsis")

# 3. Check audio_qc.rs still compiles
cargo check --manifest-path src-tauri/Cargo.toml

# 4. Verify ffmpeg placeholder exists
ls -lh src-tauri/binaries/ffmpeg.exe
# Should be small text file, not binary
```

### Post-Merge Validation

1. **Manual release build** (if possible in your environment):
   ```bash
   VERSION=0.5.1
   cargo build --release --manifest-path src-tauri/Cargo.toml
   
   # Simulate CI steps:
   mkdir -p pack_dir
   cp src-tauri/target/release/phoenix-dub-desktop.exe pack_dir/
   
   # Download ffmpeg (or use existing src-tauri/binaries/ffmpeg.exe)
   cp src-tauri/binaries/ffmpeg.exe pack_dir/
   
   # Dry-run vpk (requires Windows + .NET 8)
   dotnet tool update -g vpk
   vpk pack \
     --packId PhoenixDubDesktop \
     --packVersion "$VERSION" \
     --packDir pack_dir \
     --mainExe phoenix-dub-desktop.exe \
     --packTitle "PHOENIX DUB Desktop" \
     --icon src-tauri/icons/icon.ico \
     --releaseNotes "Test release" \
     --outputDir release_output
   ```

2. **Inspect release artifacts**:
   - Check `release_output/` for `.nupkg` (installer), `.delta`, `.sha256` files
   - Verify ffmpeg.exe is ~15–30 MB (not 0 bytes or missing)

3. **Check GitHub release**:
   - Installer should be ~130 MB (per PR #6 notes)
   - Should include delta patches for future updates

---

## Troubleshooting

### Issue: `ffmpeg.exe not found in archive`

**Cause:** SHA256 mismatch or corrupt download  
**Fix:** 
- Update URL/SHA256 in `build.yml` to latest BtbN release
- Manually verify: `curl -sL <url> | sha256sum`

### Issue: `vpk pack` fails with "ffmpeg.exe is empty"

**Cause:** Placeholder wasn't replaced, or copy step was skipped  
**Fix:**
- Ensure ffmpeg download step runs before `vpk pack`
- Add `ls -lh pack_dir/` to `build.yml` for debugging
- Verify `cp src-tauri/binaries/ffmpeg.exe pack_dir/` is included

### Issue: Installer is only ~3 MB (ffmpeg missing)

**Cause:** ffmpeg not copied to `pack_dir/`  
**Fix:**
- Confirm CI logs show `cp src-tauri/binaries/ffmpeg.exe pack_dir/` succeeded
- Check that `pack_dir/` contains both `.exe` and `ffmpeg.exe`

### Issue: GA Actions job timeout (ffmpeg download too slow)

**Cause:** Network latency, BtbN server slow  
**Fix:**
- Increase `--max-time 180` to 300+ seconds in curl
- Pre-cache ffmpeg in a separate setup step

---

## Files Modified by This Coordination

```
.github/workflows/build.yml          (✅ Add ffmpeg download + copy to pack_dir)
src-tauri/tauri.conf.json            (✅ Already handled by PR #7)
src-tauri/src/audio_qc.rs            (✅ No changes needed, PR #6 compatible)
src-tauri/binaries/ffmpeg.exe        (✅ Placeholder already in repo via PR #6)
MERGE_COORDINATION_PR6_PR7.md         (This file)
```

---

## Summary

| Step | Action | Status |
|------|--------|--------|
| 1 | PR #6 merges ffmpeg bundling to main | ✅ Done |
| 2 | PR #7 updates CI to copy ffmpeg to `pack_dir/` | ⏳ **Needs update** |
| 3 | PR #7 removes Tauri `bundle.resources` | ✅ Already done in PR #7 |
| 4 | Merge PR #7 after CI update | ⏳ **Pending** |
| 5 | Run manual workflow dispatch to test | ⏳ **Post-merge** |

---

## Questions?

If issues arise during merge:
1. Check CI logs for exact error messages
2. Verify both `src-tauri/binaries/ffmpeg.exe` exists and `.github/workflows/build.yml` has both ffmpeg + vpk steps
3. Ensure `.NET 8.x` SDK is available on Windows runner (`actions/setup-dotnet@v4`)

**Key principle:** Velopack needs ffmpeg binary in `pack_dir/` before calling `vpk pack`, just like Tauri's NSIS needs it in `bundle.resources`.
