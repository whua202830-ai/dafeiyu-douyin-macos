#!/usr/bin/env python3
"""离线更新已有 DSH 抖音 1.4.5；默认只检查，--install 才写入。"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
from datetime import datetime
from zoneinfo import ZoneInfo

NAME = 'dsh-douyin-browser-local'
VERSION = '1.4.5-macos.1'
ARCHIVE = f'{NAME}-{VERSION}.tgz'
# 该清单由同目录的打包结果填入，防止误装其他包。
EXPECTED_SHA256 = 'ef9f52c107b2a0ed42742d5f51aedbd46805b21d2f42de884950c910c5705510'
LOCK_BLOCKS = ["  dsh-douyin-browser-local@file:../../outputs/dsh-douyin-browser-local-1.4.5-macos.1.tgz:\n    resolution: {integrity: sha512-zvm+y+y0Ux/e07xJR4pzhZfy/1XarjM1ds9l9k6YL+wNJje+rpGKf/YSAjXlRhA/ww6WxU7n7r164N+98gGl5g==, tarball: file:../../outputs/dsh-douyin-browser-local-1.4.5-macos.1.tgz}\n    version: 1.4.5-macos.1\n    engines: {dsh: '>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.3.0-0', node: '>=22.13'}\n    os: [win32, darwin]\n    peerDependencies:\n      '@deepseek-ai/dsh': '>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.3.0-0'\n    peerDependenciesMeta:\n      '@deepseek-ai/dsh':\n        optional: true\n\n", "  dsh-douyin-browser-local@file:../../outputs/dsh-douyin-browser-local-1.4.5-macos.1.tgz:\n    dependencies:\n      '@playwright/cli': 0.1.22\n      '@playwright/mcp': 0.0.83\n\n"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic(file, data, mode=0o644):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + f'.macos-install-{os.getpid()}.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
        temporary.chmod(mode)
        os.replace(temporary, file)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--dsh-home', type=Path, default=Path.home() / '.dsh')
    parser.add_argument('--package', type=Path, default=Path(__file__).with_name(ARCHIVE))
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    root = args.dsh_home.resolve()
    if args.rollback:
        manifest = json.loads((args.rollback / 'manifest.json').read_text())
        if manifest['root'] != str(root):
            raise ValueError('备份与目标 DSH 目录不一致。')
        restore = {}
        for row in manifest['files']:
            target = root / row['path']
            if not target.resolve().is_relative_to(root):
                raise ValueError('备份路径越界。')
            if row['path'] == 'profiles/desktop/package.json':
                current = json.loads(target.read_text())
                original = json.loads((args.rollback / 'original' / row['path']).read_text())
                source = current.get('dependencies', {}).get(NAME, '')
                if not source.startswith('file:') or Path(source[5:]).name != ARCHIVE:
                    raise ValueError('抖音依赖已有其他版本更新，未回滚 profile。')
                current['dependencies'][NAME] = original['dependencies'][NAME]
                restore[row['path']] = (json.dumps(current, ensure_ascii=False, indent=2) + '\n').encode()
                continue
            if not target.is_file() or sha(target.read_bytes()) != row['after']:
                raise ValueError(f'文件已有后续修改，未执行回滚：{row["path"]}')
        if not args.install:
            print('回滚检查通过；追加 --install 才执行。')
            return
        for row in reversed(manifest['files']):
            target = root / row['path']
            if row['path'] in restore:
                atomic(target, restore[row['path']], row['mode'])
            elif row['existed']:
                atomic(target, (args.rollback / 'original' / row['path']).read_bytes(), row['mode'])
            else:
                target.unlink()
        print('已恢复本次更新的文件；请重新加载抖音插件。')
        return

    archive = args.package.read_bytes()
    if sha(archive) != EXPECTED_SHA256:
        raise ValueError('安装包校验不一致，未改动 DSH。')
    profile = root / 'profiles/desktop'
    target = profile / 'node_modules' / NAME
    old = json.loads((target / 'package.json').read_text())
    if old.get('name') != NAME or old.get('version') not in ['1.4.5', VERSION]:
        raise ValueError('此安装器只适配已有 1.4.5；请先核对当前版本。')
    installed_profile = json.loads((profile / 'package.json').read_text())
    if NAME not in installed_profile.get('dependencies', {}):
        raise ValueError('profile 未安装抖音插件；此安装器仅更新已有安装。')
    writes = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar.getmembers():
            parts = PurePosixPath(member.name).parts
            if member.isdir():
                continue
            if not member.isfile() or not parts or parts[0] != 'package' or any(p in ['..', 'state', 'node_modules', '.env'] for p in parts):
                raise ValueError('包中存在不允许安装的路径。')
            writes[target.joinpath(*parts[1:])] = tar.extractfile(member).read()
    release = root / 'douyin-browser/releases' / ARCHIVE
    writes[release] = archive
    specifier = f'file:../../douyin-browser/releases/{ARCHIVE}'
    installed_profile['dependencies'][NAME] = specifier
    for lockfile in [profile / 'pnpm-lock.yaml', profile / 'node_modules/.pnpm/lock.yaml']:
        if not lockfile.exists():
            continue
        content = lockfile.read_text()
        if f'{NAME}@{specifier}:' in content:
            continue
        content, count = re.subn(r'(      dsh-douyin-browser-local:\n        specifier: )1\.4\.5(\n        version: )1\.4\.5\n', lambda m: m[1] + specifier + m[2] + specifier + '\n', content)
        if count != 1:
            raise ValueError('本插件 lockfile 入口与预期不一致，未修改。')
        blocks = iter(LOCK_BLOCKS)
        content, count = re.subn(r'^  dsh-douyin-browser-local@1\.4\.5:\n(?:(?:    .*|)\n)*', lambda m: next(blocks).replace('file:../../outputs/' + ARCHIVE, specifier), content, flags=re.M)
        if count != 2:
            raise ValueError('本插件 lockfile 包记录与预期不一致，未修改。')
        writes[lockfile] = content.encode()
    skill = root / 'skills/dsh-douyin/SKILL.md'
    writes[skill] = ('''---
name: dsh-douyin
description: 在 Mac 版 DeepSeek Harness 中使用专用 Chrome 或 Edge 刷抖音、采样画面并排查插件启动问题；遵守已有观看额度与互动许可。
---

# DSH 抖音 Mac 适配版

先阅读[已安装插件的完整 skill](../../profiles/desktop/node_modules/dsh-douyin-browser-local/skill/SKILL.md)，使用该文件规定的观看、模型采样、许可与自检流程。Mac 安装及排障见 [Mac 说明](../../profiles/desktop/node_modules/dsh-douyin-browser-local/docs/macos.md)。

本地版本 1.4.5-macos.1 支持已安装的 Chrome，无需强制安装 Edge。独立 Node 优先使用 DSH 自带 primary-runtime；不要用 Electron 包装脚本或 Codex 的私有运行时。先自检，再打开保持暂停的专用准备页；登录及验证码交由用户。不要因修复插件擅自启动观看、评论、分享或私信服务。
''').encode()
    # 包清单与 profile 最后写入，避免宿主看见尚未复制完成的代码。
    package_data = writes.pop(target / 'package.json')
    writes[target / 'package.json'] = package_data
    writes[profile / 'package.json'] = (json.dumps(installed_profile, ensure_ascii=False, indent=2) + '\n').encode()
    changes = []
    for file, data in writes.items():
        if not file.resolve().is_relative_to(root):
            raise ValueError('检测到跨 DSH 边界的软链接，未安装。')
        before = file.read_bytes() if file.exists() else None
        if before != data:
            changes.append((file, data, before, file.stat().st_mode & 0o777 if file.exists() else 0o644))
    print(json.dumps({'version': VERSION, 'changedFiles': len(changes), 'target': str(target), 'mode': 'install' if args.install else 'check'}, ensure_ascii=False))
    if not args.install or not changes:
        return
    backup = root / 'douyin-browser/backups' / datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S-macos.1')
    backup.mkdir(parents=True, exist_ok=False)
    rows = []
    for file, data, before, mode in changes:
        relative = file.relative_to(root).as_posix()
        if before is not None:
            atomic(backup / 'original' / relative, before, mode)
        rows.append({'path': relative, 'existed': before is not None, 'mode': mode, 'before': sha(before) if before is not None else None, 'after': sha(data)})
    atomic(backup / 'manifest.json', (json.dumps({'root': str(root), 'version': VERSION, 'files': rows}, ensure_ascii=False, indent=2) + '\n').encode(), 0o600)
    for file, data, before, mode in changes:
        # 避免覆盖备份后另一个进程刚刚写入的内容。
        if (file.read_bytes() if file.exists() else None) != before:
            raise ValueError(f'安装时文件已被其他进程更新，请核对备份：{file}')
        atomic(file, data, mode)
    print(json.dumps({'installed': VERSION, 'backup': str(backup), 'note': '请重新加载本插件；必要时在其他工作结束后正常重开 DSH。'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
