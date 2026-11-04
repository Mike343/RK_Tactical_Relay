"""Build and verify the Windows distribution. Run via BUILD_APPLICATION.cmd."""
import ctypes
import hashlib
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import venv
import zipfile

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'app'
NAME = 'RKTacticalCompanion'


def run(command, **kwargs):
    subprocess.run([str(arg) for arg in command], cwd=ROOT, check=True, **kwargs)


def runtime_files():
    get_path = ctypes.WinDLL('kernel32').GetModuleFileNameW
    get_path.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32]
    get_path.restype = ctypes.c_uint32
    paths = []
    for name in ('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
        dll = ctypes.WinDLL(name)
        buf = ctypes.create_unicode_buffer(32768)
        if not get_path(dll._handle, buf, len(buf)):
            raise OSError('Cannot locate Microsoft runtime ' + name)
        paths.append(Path(buf.value))
    return paths


def main():
    if sys.platform != 'win32' or struct.calcsize('P') != 8:
        raise RuntimeError('Build on 64-bit Windows with 64-bit Python.')
    if not (3, 10) <= sys.version_info[:2] <= (3, 14):
        raise RuntimeError('Build with Python 3.10 through 3.14 (64-bit).')
    print('Preparing Windows build tools. The first build downloads PyInstaller.', flush=True)
    environment = ROOT / '.build-python'
    if not environment.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / 'Scripts' / 'python.exe'
    run([python, '-m', 'pip', 'install', '--disable-pip-version-check', 'pyinstaller==6.16.0'])
    run([python, '-S', APP / 'tests' / 'exercise.py'])
    run([python, '-S', APP / 'tests' / 'silence.py'])
    # SimConnect.dll depends on these Microsoft redistributable runtime files.
    runtimes = runtime_files()
    with tempfile.TemporaryDirectory(prefix='rk_companion_build_') as staging:
        staging = Path(staging)
        command = [python, '-m', 'PyInstaller', '--noconfirm', '--clean',
                   '--onefile', '--console', '--name', NAME,
                   '--distpath', staging / 'dist', '--workpath', staging / 'work',
                   '--specpath', staging, '--paths', APP / 'vendor',
                   '--collect-submodules', 'websockets',
                   '--add-binary', str(APP / 'SimConnect.dll') + ';.',
                   '--add-data', str(APP / 'Audio') + ';Audio',
                   '--add-data', str(APP / 'companion.ini') + ';.',
                   '--add-data', str(ROOT / 'USER_README.txt') + ';.',
                   '--add-data', str(APP / 'vendor' / 'websockets' / 'LICENSE') + ';licenses/websockets']
        for path in runtimes:
            command += ['--add-binary', str(path) + ';.']
        command.append(APP / 'companion.py')
        run(command)
        exe = staging / 'dist' / (NAME + '.exe')
        raw = exe.read_bytes()
        pe = struct.unpack_from('<I', raw, 0x3c)[0]
        if raw[:2] != b'MZ' or raw[pe:pe+4] != b'PE\0\0' or struct.unpack_from('<H', raw, pe+4)[0] != 0x8664:
            raise RuntimeError('Build did not produce a Windows x64 executable.')
        # Copy ONLY the EXE into an empty directory, away from build inputs.
        # This must load its embedded DLL, defaults and WAVs without sidecar files.
        isolated = staging / 'standalone-check'
        isolated.mkdir()
        isolated_exe = isolated / exe.name
        shutil.copy2(exe, isolated_exe)
        subprocess.run([str(isolated_exe), '--check-install'], cwd=isolated,
                       check=True, timeout=120)
        if {p.name for p in isolated.iterdir()} != {exe.name}:
            raise RuntimeError('Installation check created unexpected external files.')
        output = ROOT / 'RELEASE'
        output.mkdir(exist_ok=True)
        target = output / 'RK_Tactical_Companion_Windows.zip'
        temporary = output / 'RK_Tactical_Companion_Windows.zip.tmp'
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(exe, exe.name)
        temporary.replace(target)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        target.with_suffix('.zip.sha256').write_text(digest + '  ' + target.name + '\n', encoding='ascii')
        executable_target = output / exe.name
        executable_temporary = output / (exe.name + '.tmp')
        shutil.copy2(exe, executable_temporary)
        executable_temporary.replace(executable_target)
        print('\nREADY TO SEND\n' + str(target), flush=True)
        print('Standalone EXE: ' + str(executable_target), flush=True)
        print('Upload that EXE alone, or the ZIP containing just that EXE.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print('\nBUILD FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
