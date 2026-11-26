import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


path = Path(__file__).resolve().parents[1] / 'infra/scripts/teleop-update'
loader = importlib.machinery.SourceFileLoader('teleop_update', str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
updater = importlib.util.module_from_spec(spec)
loader.exec_module(updater)


class ImageUpdateTest(unittest.TestCase):
    def test_site_gateway_patch_is_verified_only_for_its_installed_release(self):
        base = 'registry/gateway@sha256:' + 'a' * 64
        patch_info = {'image': 'site-gateway:tested', 'image_id': 'sha256:' + 'b' * 64, 'base_image': base}
        receipt = {'version': '1.1.3', 'gateway_patch': patch_info}
        inspected = {'Id': patch_info['image_id'], 'Os': 'linux', 'Architecture': 'amd64'}
        with patch.object(updater.subprocess, 'check_output', return_value=json.dumps([inspected])) as inspect:
            self.assertIsNone(updater.site_gateway_patch({}, '1.1.3', base))
            self.assertIsNone(updater.site_gateway_patch(receipt, '1.1.4', 'new-release'))
            inspect.assert_not_called()
            self.assertEqual(updater.site_gateway_patch(receipt, '1.1.3', base), patch_info)
            inspect.assert_called_once_with(['docker', 'image', 'inspect', '--', patch_info['image']])
            with self.assertRaisesRegex(RuntimeError, 'different release image'):
                updater.site_gateway_patch(receipt, '1.1.3', 'different-image')
            inspect.return_value = json.dumps([{**inspected, 'Id': 'replaced'}])
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                updater.site_gateway_patch(receipt, '1.1.3', base)

    def test_change_images_preserves_ports_urls_volumes_and_extra_services(self):
        gateway = {'image': 'gateway:local', 'build': {'context': '/src'},
                   'environment': {'OIDC_ISSUER': 'https://login.example.test:9443'},
                   'volumes': ['operations:/var/lib/teleop']}
        original = {'services': {'gateway': gateway, 'caddy': {'ports': ['443:9443']},
                                 'local-metrics': {'image': 'monitor:current'}},
                    'volumes': {'operations': {}}}
        refs = {'gateway': 'registry/gateway@sha256:abc', 'caddy': 'registry/caddy@sha256:def'}
        result = updater.update_config(original, refs)
        self.assertEqual(result['services']['gateway'], {
            'image': refs['gateway'], 'platform': 'linux/amd64', 'pull_policy': 'missing',
            'environment': gateway['environment'], 'volumes': gateway['volumes']})
        self.assertEqual(result['services']['caddy']['ports'], ['443:9443'])
        self.assertEqual(result['services']['local-metrics'], original['services']['local-metrics'])
        self.assertEqual(result['volumes'], original['volumes'])
        self.assertIn('build', gateway)
        self.assertEqual(updater.update_config(result, refs), result)

    def test_failed_verification_restores_previous_config_before_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            config = state / 'compose.json'
            config.write_bytes(b'original')
            calls = []

            def run(command, **kwargs):
                calls.append((command, config.read_bytes()))

            def fail():
                raise RuntimeError('readiness failed')

            with (patch.object(updater, 'check_control'), patch.object(updater, 'cold_backup'),
                  patch.object(updater.subprocess, 'run', side_effect=run),
                  self.assertRaisesRegex(RuntimeError, 'readiness failed')):
                updater.activate(['compose'], config, b'original', b'new', {}, 'helper', state, fail)
            self.assertEqual([content for command, content in calls if 'up' in command], [b'new', b'original'])
            self.assertFalse((state / '.teleop-update-pending').exists())
            self.assertEqual(config.read_bytes(), b'original')

    def test_backup_failure_resumes_existing_containers(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            config = state / 'compose.json'
            config.write_bytes(b'original')
            with (patch.object(updater, 'check_control'),
                  patch.object(updater, 'cold_backup', side_effect=OSError('out of space')),
                  patch.object(updater.subprocess, 'run') as run,
                  self.assertRaisesRegex(OSError, 'out of space')):
                updater.activate(['compose'], config, b'original', b'new', {}, 'helper', state, None)
            self.assertEqual(run.call_args.args[0], ['compose', 'start'])
            self.assertEqual(config.read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
