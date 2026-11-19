import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_release', ROOT / 'infra/scripts/package-release.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class ReleaseTest(unittest.TestCase):
    def test_package_contains_one_deployer_fixed_images_and_verified_launcher(self):
        image_id = 'sha256:' + 'a' * 64
        info = dict(Os='linux', Architecture='amd64', Id=image_id)
        process = argparse.Namespace(stdout=io.BytesIO(b'docker-image-export'), wait=lambda: 0)
        with tempfile.TemporaryDirectory() as directory, \
                patch('sys.argv', ['package-release.py', '--output', directory, '--version', '1.2.3']), \
                patch.object(package.subprocess, 'check_output', return_value='linux/amd64\n'), \
                patch.object(package.subprocess, 'run', return_value=argparse.Namespace(returncode=0)), \
                patch.object(package, 'inspect', return_value=info), \
                patch.object(package, 'run') as run, \
                patch.object(package.subprocess, 'Popen', return_value=process):
            package.main()
            archive = Path(directory) / 'teleop-1.2.3-linux-amd64.tar.gz'
            with tarfile.open(archive) as tar:
                prefix = 'teleop-1.2.3-linux-amd64/'
                contents = {name: tar.extractfile(prefix + name).read()
                            for name in ('release-images.json', 'teleop', 'images.tar.gz', 'README.txt', 'SHA256SUMS')}
            manifest = json.loads(contents['release-images.json'])
            self.assertEqual(set(manifest['images']), {'gateway', 'frontend', *package.DEPENDENCIES})
            self.assertEqual(set(manifest['image_ids']), set(manifest['images']))
            self.assertEqual(manifest['setup_image_id'], image_id)
            self.assertNotIn(b'__SETUP_IMAGE', contents['teleop'])
            self.assertIn(b'sha256sum --check --strict', contents['teleop'])
            self.assertEqual(gzip.decompress(contents['images.tar.gz']), b'docker-image-export')
            for line in contents['SHA256SUMS'].decode().splitlines():
                digest, filename = line.split('  ')
                self.assertEqual(digest, hashlib.sha256(contents[filename]).hexdigest())
            builds = [call.args[0] for call in run.call_args_list if call.args[0][1] == 'build']
            self.assertEqual(len(builds), 3)  # Gateway, Frontend and the deployment-tool image.
            setup_context = Path(builds[-1][-1])
            self.assertEqual(setup_context.name, 'setup')
            checksum = archive.with_suffix('.gz.sha256').read_text().split()[0]
            self.assertEqual(checksum, hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual(sorted(path.name for path in Path(directory).iterdir()),
                             [archive.name, archive.name + '.sha256'])

    def test_wrong_build_host_fails_before_building_or_creating_output(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('sys.argv', ['package-release.py', '--output', directory + '/output']), \
                patch.object(package.subprocess, 'check_output', return_value='linux/arm64\n'), \
                patch.object(package, 'run') as run, patch('sys.stderr', io.StringIO()):
            with self.assertRaises(SystemExit):
                package.main()
            run.assert_not_called()
            self.assertFalse((Path(directory) / 'output').exists())

    def test_failed_image_export_leaves_no_release_archive(self):
        process = argparse.Namespace(stdout=io.BytesIO(b'partial-export'), wait=lambda: 1)
        with tempfile.TemporaryDirectory() as directory, \
                patch('sys.argv', ['package-release.py', '--output', directory]), \
                patch.object(package.subprocess, 'check_output', return_value='linux/amd64\n'), \
                patch.object(package.subprocess, 'run', return_value=argparse.Namespace(returncode=0)), \
                patch.object(package, 'inspect', return_value=dict(Os='linux', Architecture='amd64',
                                                                  Id='sha256:' + 'a' * 64)), \
                patch.object(package, 'run'), \
                patch.object(package.subprocess, 'Popen', return_value=process):
            with self.assertRaisesRegex(RuntimeError, 'export failed'):
                package.main()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_corrupt_bundle_is_rejected_before_docker_load(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            (bundle / 'teleop').write_text((ROOT / 'infra/release/teleop').read_text())
            (bundle / 'images.tar.gz').write_bytes(b'corrupted')
            (bundle / 'SHA256SUMS').write_text('0' * 64 + '  images.tar.gz\n')
            docker = bundle / 'docker'
            docker.write_text('#!/bin/sh\nprintf invoked > "' + str(bundle / 'invoked') + '"\n')
            docker.chmod(0o755)
            result = subprocess.run(['bash', str(bundle / 'teleop'), 'load'],
                                    env={**os.environ, 'PATH': str(bundle) + ':' + os.environ['PATH']},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('FAILED', result.stdout)
            self.assertFalse((bundle / 'invoked').exists())


if __name__ == '__main__':
    unittest.main()
