"""将已验证的构建结果打包，并检查 ZIP 的内容与校验值。"""
import hashlib
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
version = json.loads((root / 'package.json').read_text())['version']
manifest = json.loads((dist / 'manifest.json').read_text())
source_manifest = json.loads((root / 'public/manifest.json').read_text())
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
    raise ValueError('版本格式不正确')
if version == '0.0.0' or any(int(part) > 65535 for part in version.split('.')):
    raise ValueError('版本超出扩展允许范围')
if manifest != source_manifest or manifest['version'] != version:
    raise ValueError('构建 manifest 与源文件或项目版本不一致，请重新构建')
required = {'manifest.json', 'app.html', manifest['background']['service_worker'], *manifest['icons'].values()}
files = {}
for path in sorted(dist.rglob('*')):
    if path.is_symlink():
        raise ValueError(f'构建目录不能包含符号链接：{path}')
    if path.is_file():
        name = path.relative_to(dist).as_posix()
        if path.suffix in {'.map', '.ts', '.tsx', '.zip'} or any(part.startswith('.') for part in Path(name).parts):
            raise ValueError(f'发现不应分发的文件：{name}')
        files[name] = path.read_bytes()
if not required <= files.keys() or not any(name.startswith('assets/') and name.endswith('.js') for name in files):
    raise ValueError('构建目录缺少扩展必需文件')
out = root / 'release'
out.mkdir(exist_ok=True)
archive = out / f'WeTrim-{version}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
    for name, content in files.items():
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        bundle.writestr(info, content)
with zipfile.ZipFile(archive) as bundle:
    if bundle.testzip() is not None or set(bundle.namelist()) != set(files):
        raise ValueError('ZIP 完整性检查失败')
    for name, content in files.items():
        if bundle.read(name) != content:
            raise ValueError(f'ZIP 内容不一致：{name}')
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix('.zip.sha256')).write_text(f'{digest}  {archive.name}\n')
print(f'已生成并校验 {archive.relative_to(root)}（{len(files)} 个文件）')
