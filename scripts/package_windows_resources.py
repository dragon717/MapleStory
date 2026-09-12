"""Pack the exported runtime resources; no WZ, dependencies, or account data."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    subprocess.run(["node", str(ROOT / "scripts/check_windows_resources.cjs")], check=True)
    files = sorted(
        p for p in (ROOT / "client/public-tms273").rglob("*")
        if p.is_file() and p.name != ".DS_Store"
    ) + sorted((ROOT / "shared").glob("*.json"))
    manifest = json.loads((ROOT / "client/public-tms273/assets/manifest.json").read_text(encoding="utf-8"))
    temporary_root = ROOT / "build/tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="resources-package-", dir=temporary_root) as stage_name:
        stage = Path(stage_name) / "package"
        stage.mkdir()
        archive = stage / "MapleStory-TMS273-resources.zip"
        temporary = archive.with_suffix(".zip.tmp")
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            for file in files:
                if file.is_symlink():
                    raise ValueError(f"Resource must be a regular file: {file}")
                output.write(file, file.relative_to(ROOT).as_posix())
        with zipfile.ZipFile(temporary) as output:
            assert output.testzip() is None, "ZIP CRC check failed"
            assert len(output.namelist()) == len(files), "ZIP file count mismatch"
            for file in files:
                name = file.relative_to(ROOT).as_posix()
                assert hashlib.sha256(output.read(name)).digest() == hashlib.sha256(file.read_bytes()).digest(), name
        temporary.replace(archive)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
        print(f"{archive.name}: {manifest['contentVersion']}, {len(files)} files, {archive.stat().st_size:,} bytes")
        print(f"SHA256: {digest}")
        subprocess.run(["node", str(ROOT / "scripts/publish-package.cjs"), "resources", str(stage)], check=True)
        print("Extract directly into the project root (the folder containing start.bat).")


if __name__ == "__main__":
    main()
