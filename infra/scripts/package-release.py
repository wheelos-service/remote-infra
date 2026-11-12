#!/usr/bin/env python3
"""Build and export a ready-to-run linux/amd64 release on an x86 Linux Docker host."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
DEPENDENCIES = {'postgres': 'postgres:16-alpine', 'redis': 'redis:7-alpine',
                'casdoor': 'casbin/casdoor:v4.25.0', 'livekit': 'livekit/livekit-server:v1.13.11',
                'caddy': 'caddy:2-alpine', 'storage-init': 'alpine:3.20'}


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def inspect(image):
    return json.loads(subprocess.check_output(['docker', 'image', 'inspect', image]))[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--version', default='1.1.0')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9][a-z0-9.-]{0,50}', args.version):
        parser.error('use a numeric release version with lowercase letters, dots or hyphens')
    platform = subprocess.check_output(['docker', 'version', '--format',
                                       '{{.Server.Os}}/{{.Server.Arch}}'], text=True).strip()
    if platform != 'linux/amd64':
        parser.error('build this release on a linux/amd64 Docker host')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = f'teleop-{args.version}-linux-amd64'
    archive = output / (name + '.tar.gz')
    if archive.exists():
        parser.error('output archive already exists; select a different directory or version')
    images = {key: f'teleop-{key}:{args.version}-amd64'
              for key in ('gateway', 'frontend', *DEPENDENCIES)}
    setup_image = f'teleop-setup:{args.version}-amd64'
    go_proxy = ['--build-arg', 'GOPROXY'] if os.environ.get('GOPROXY') else []
    run(['docker', 'build', '--platform', platform, *go_proxy, '-t', images['gateway'],
         str(ROOT / 'apps/teleop-gateway')])
    run(['docker', 'build', '--platform', platform, '-t', images['frontend'],
         '-f', str(ROOT / 'frontend/Dockerfile'), str(ROOT)])
    for key, upstream in DEPENDENCIES.items():
        if subprocess.run(['docker', 'image', 'inspect', upstream], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode:
            run(['docker', 'pull', '--platform', platform, upstream])
        info = inspect(upstream)
        if info['Os'] + '/' + info['Architecture'] != platform:
            raise RuntimeError('dependency has the wrong architecture: ' + upstream)
        run(['docker', 'tag', upstream, images[key]])
    manifest = {'version': args.version, 'platform': platform, 'images': images,
                'image_ids': {key: inspect(image)['Id'] for key, image in images.items()}}
    with tempfile.TemporaryDirectory(prefix='teleop-package-', dir=output) as temporary:
        temp = Path(temporary)
        context = temp / 'setup'
        context.mkdir()
        shutil.copyfile(ROOT / 'infra/scripts/deploy.py', context / 'deploy.py')
        shutil.copyfile(ROOT / 'infra/release/Dockerfile', context / 'Dockerfile')
        (context / 'release-images.json').write_text(json.dumps(manifest, indent=2) + '\n')
        run(['docker', 'build', '--platform', platform, '-t', setup_image, str(context)])
        if inspect(setup_image)['Architecture'] != 'amd64':
            raise RuntimeError('setup image has the wrong architecture')
        bundle = temp / name
        bundle.mkdir()
        launcher = (ROOT / 'infra/release/teleop').read_text().replace('__SETUP_IMAGE__', setup_image)
        (bundle / 'teleop').write_text(launcher)
        (bundle / 'teleop').chmod(0o755)
        shutil.copyfile(ROOT / 'infra/release/README.txt', bundle / 'README.txt')
        shutil.copyfile(context / 'release-images.json', bundle / 'release-images.json')
        manifest['setup_image'] = setup_image
        manifest['setup_image_id'] = inspect(setup_image)['Id']
        (bundle / 'release-images.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print('Exporting compiled services, setup image and all runtime dependencies...', flush=True)
        with (bundle / 'images.tar.gz').open('wb') as target:
            save = subprocess.Popen(['docker', 'save', setup_image, *images.values()], stdout=subprocess.PIPE)
            try:
                with gzip.GzipFile(fileobj=target, mode='wb', compresslevel=1, mtime=0) as compressed:
                    shutil.copyfileobj(save.stdout, compressed)
            finally:
                save.stdout.close()
            if save.wait() != 0:
                raise RuntimeError('Docker image export failed')
        digest = hashlib.sha256()
        with (bundle / 'images.tar.gz').open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        (bundle / 'SHA256SUMS').write_text(digest.hexdigest() + '  images.tar.gz\n')
        # Images are already compressed; keep the outer archive inexpensive.
        with tarfile.open(archive, 'w:gz', compresslevel=1) as tar:
            tar.add(bundle, arcname=name)
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    archive.with_suffix(archive.suffix + '.sha256').write_text(digest.hexdigest() + '  ' + archive.name + '\n')
    print(f'Ready: {archive}\nSHA-256: {digest.hexdigest()}', flush=True)


if __name__ == '__main__':
    main()
