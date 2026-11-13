import argparse
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load('deploy', 'infra/scripts/deploy.py')


class DeploymentTest(unittest.TestCase):
    def settings(self, **kwargs):
        return argparse.Namespace(**dict(dict(local=None, lan_ip=None, domain=None,
                                             auth_domain=None, project=None, media_ip=None,
                                             acme_email=None, acme_staging=None), **kwargs))

    def test_prebuilt_release_never_builds_or_pulls_and_preserves_local_secrets(self):
        images = {name: f'teleop-{name}:1.0.0-rc1-amd64' for name in
                  ('gateway', 'frontend', 'postgres', 'redis', 'casdoor', 'livekit', 'caddy',
                   'adguardhome', 'storage-init')}
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'compose') as compose, \
                patch.multiple(deploy, RELEASE_IMAGES=images, LOCAL=True, PUBLIC_TLS=False,
                               MEDIA=False, APP='http://127.0.0.1:8443', AUTH='http://127.0.0.1:8444'):
            state = Path(directory)
            values = deploy.prepare(state)
            services = json.loads((state / 'compose.json').read_text())['services']
            self.assertEqual(set(services), set(images) - {'adguardhome'})
            for name, service in services.items():
                self.assertEqual(service['image'], images[name])
                self.assertEqual(service['platform'], 'linux/amd64')
                self.assertEqual(service['pull_policy'], 'never')
                self.assertNotIn('build', service)
            compose.reset_mock()
            with self.assertRaisesRegex(RuntimeError, 'already compiled'):
                deploy.build(state)
            compose.assert_not_called()
            self.assertEqual(deploy.prepare(state), values)

    def test_release_manifest_rejects_missing_services_wrong_architecture_and_interpolation(self):
        images = {name: f'teleop-{name}:test' for name in
                  ('gateway', 'frontend', 'postgres', 'redis', 'casdoor', 'livekit', 'caddy',
                   'adguardhome', 'storage-init')}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release-images.json'
            ids = {name: 'sha256:' + 'a' * 64 for name in images}
            path.write_text(json.dumps(dict(platform='linux/amd64', images=images, image_ids=ids)))
            info = json.dumps([dict(Os='linux', Architecture='amd64', Id='sha256:' + 'a' * 64)])
            with patch.object(deploy, 'run', return_value=argparse.Namespace(stdout=info)) as run:
                self.assertEqual(deploy.load_release_images(path), images)
                self.assertEqual(run.call_count, len(images))
            for manifest in (dict(platform='linux/arm64', images=images),
                             dict(platform='linux/amd64', images={'gateway': 'teleop:test'}),
                             dict(platform='linux/amd64', images={**images, 'gateway': '${HOST_IMAGE}'})):
                path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(RuntimeError, 'invalid prebuilt'):
                    deploy.load_release_images(path)

    def test_release_refuses_missing_ids_retagged_images_and_wrong_platform(self):
        images = {name: f'teleop-{name}:test' for name in
                  ('gateway', 'frontend', 'postgres', 'redis', 'casdoor', 'livekit', 'caddy',
                   'adguardhome', 'storage-init')}
        ids = {name: 'sha256:' + 'a' * 64 for name in images}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release-images.json'
            path.write_text(json.dumps(dict(platform='linux/amd64', images=images)))
            with self.assertRaisesRegex(RuntimeError, 'exact image ID'):
                deploy.load_release_images(path)
            path.write_text(json.dumps(dict(platform='linux/amd64', images=images, image_ids=ids)))
            for info in (dict(Os='linux', Architecture='amd64', Id='sha256:' + 'b' * 64),
                         dict(Os='linux', Architecture='arm64', Id=ids['gateway'])):
                with patch.object(deploy, 'run', return_value=argparse.Namespace(stdout=json.dumps([info]))):
                    with self.assertRaisesRegex(RuntimeError, 'release image mismatch'):
                        deploy.load_release_images(path)

    def test_source_build_only_builds_applications_with_generated_compose(self):
        with patch.object(deploy, 'compose') as compose, patch.object(deploy, 'RELEASE_IMAGES', None):
            deploy.build(Path('/private/state'))
            compose.assert_called_once_with(Path('/private/state'), 'build', 'gateway', 'frontend')

    def test_source_and_release_share_prepare_start_verify_without_release_build(self):
        for prebuilt in (False, True):
            with self.subTest(prebuilt=prebuilt), tempfile.TemporaryDirectory() as directory:
                state = Path(directory)
                state.chmod(0o700)
                argv = ['deploy.py', '--state', directory, '--local', 'all']
                if prebuilt:
                    argv += ['--images', str(state / 'release-images.json')]
                events = []
                with patch('sys.argv', argv), patch.object(deploy, 'check_project'), \
                        patch.object(deploy, 'load_release_images', return_value={'gateway': 'release'}), \
                        patch.object(deploy, 'prepare', side_effect=lambda _: events.append('prepare') or {}), \
                        patch.object(deploy, 'build', side_effect=lambda _: events.append('build')), \
                        patch.object(deploy, 'start', side_effect=lambda *_: events.append('start')), \
                        patch.object(deploy, 'verify', side_effect=lambda *a, **kw: events.append('verify')), \
                        patch.object(deploy, 'connection_info'), patch('sys.stdout', io.StringIO()), \
                        patch.multiple(deploy, RELEASE_IMAGES=None, LOCAL=False, PUBLIC_TLS=False,
                                       PROJECT='teleop', MEDIA_IP='', ACME_EMAIL='', ACME_STAGING=False):
                    deploy.main()
                self.assertEqual(events, ['prepare', 'start', 'verify'] if prebuilt else
                                 ['prepare', 'build', 'start', 'verify'])

    def test_public_deployment_is_self_contained_and_secrets_stay_private(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'compose'), \
                patch.multiple(deploy, PUBLIC_TLS=True, LOCAL=False, MEDIA=True,
                               APP='https://console.example.test', AUTH='https://auth.example.test'):
            state = Path(directory)
            values = deploy.prepare(state)
            config = json.loads((state / 'compose.json').read_text())
            services = config['services']
            self.assertNotIn('adguardhome', services)
            self.assertEqual(services['caddy']['ports'], ['80:80', '443:443'])
            self.assertEqual(services['caddy']['networks']['default']['aliases'],
                             ['console.example.test', 'auth.example.test'])
            self.assertEqual(services['livekit']['ports'],
                             ['0.0.0.0:7881:7881/tcp', '0.0.0.0:51000-51100:51000-51100/udp'])
            for name, service in services.items():
                if name not in ('caddy', 'livekit'):
                    self.assertNotIn('ports', service)
            gateway = services['gateway']
            env = gateway['environment']
            self.assertEqual(env['AUTH_MODE'], 'oidc')
            self.assertEqual(env['AUTHORIZATION_MODE'], 'managed')
            self.assertEqual(env['AUTHORIZATION_ONLINE_MUTATIONS'], 'true')
            self.assertEqual(env['SIMULATED_CONTROL_VEHICLES_JSON'], '[]')
            self.assertEqual(env['CONTROL_HANDOVER_ACK_ENABLED'], 'false')
            self.assertNotIn('SSL_CERT_FILE', env)
            self.assertNotIn('network_mode', gateway)
            self.assertFalse(any('root.crt' in volume for volume in gateway['volumes']))
            self.assertNotIn('tls internal', (state / 'Caddyfile').read_text())
            self.assertEqual((state / 'Caddyfile').read_text().count(
                'dir https://acme-v02.api.letsencrypt.org/directory'), 2)
            self.assertIn('reverse_proxy gateway:8080', (state / 'Caddyfile').read_text())
            self.assertIn('use_external_ip: true', (state / 'livekit.yaml').read_text())
            self.assertIn('/api/webhook/livekit', (state / 'livekit.yaml').read_text())
            self.assertEqual(gateway['depends_on']['storage-init']['condition'], 'service_completed_successfully')
            public = (state / 'runtime-config.js').read_text()
            for key in ('postgres', 'livekit', 'management_secret', 'admin_password', 'encryption'):
                self.assertNotIn(values[key], public)
            for name in ('secrets.json', 'onboarding.json', 'onboarding.key', 'compose.json'):
                self.assertEqual((state / name).stat().st_mode & 0o777, 0o600)
            self.assertEqual((state / 'runtime-config.js').stat().st_mode & 0o777, 0o644)
            self.assertEqual(deploy.prepare(state), values)
            self.assertNotIn('vehicles', json.loads((state / 'casdoor-seed.json').read_text()))

    def test_acme_staging_email_and_certificate_storage_are_explicit_and_persistent(self):
        for staging in (False, True):
            with self.subTest(staging=staging), tempfile.TemporaryDirectory() as directory, \
                    patch.object(deploy, 'compose'), \
                    patch.multiple(deploy, PUBLIC_TLS=True, LOCAL=False, MEDIA=False,
                                   ACME_EMAIL='ops@example.com', ACME_STAGING=staging,
                                   APP='https://console.example.com', AUTH='https://auth.example.com'):
                state = Path(directory)
                deploy.prepare(state)
                caddyfile = (state / 'Caddyfile').read_text()
                ca = deploy.ACME_STAGING_URL if staging else deploy.ACME_PRODUCTION_URL
                self.assertEqual(caddyfile.count(f'dir {ca}'), 2)
                self.assertEqual(caddyfile.count('email ops@example.com'), 2)
                self.assertNotIn('tls internal', caddyfile)
                services = json.loads((state / 'compose.json').read_text())['services']
                self.assertIn(f"{state / 'caddy-data'}:/data", services['caddy']['volumes'])
                marker = state / 'caddy-data' / 'existing-account'
                marker.write_text('preserved')
                deploy.prepare(state)
                self.assertEqual(marker.read_text(), 'preserved')
                output = io.StringIO()
                with redirect_stdout(output):
                    deploy.connection_info(state)
                self.assertIn('not publicly trusted' if staging else 'renews certificates automatically',
                              output.getvalue())

    def test_lan_split_dns_uses_public_domain_urls_and_internal_tls(self):
        ip = '192.168.1.50'
        app = 'https://console.example.com'
        auth = 'https://login.example.com'
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'compose'), \
                patch.multiple(deploy, LOCAL=False, PUBLIC_TLS=False, LAN_DOMAIN=True, MEDIA=True,
                               IP=ip, APP=app, AUTH=auth):
            state = Path(directory)
            deploy.prepare(state)
            config = json.loads((state / 'compose.json').read_text())
            services = config['services']
            adguard = services['adguardhome']
            self.assertEqual(adguard['image'], 'adguard/adguardhome:v0.107.80')
            self.assertEqual(adguard['ports'], [
                f'{ip}:53:53/tcp', f'{ip}:53:53/udp', f'{ip}:3000:3000/tcp',
            ])
            self.assertEqual(adguard['volumes'], [
                'adguard-work:/opt/adguardhome/work',
                'adguard-conf:/opt/adguardhome/conf',
            ])
            self.assertIn('adguard-work', config['volumes'])
            self.assertIn('adguard-conf', config['volumes'])
            self.assertEqual(services['caddy']['ports'], [f'{ip}:443:443'])
            self.assertEqual(services['caddy']['networks']['default']['aliases'],
                             ['console.example.com', 'login.example.com'])
            self.assertEqual(services['caddy']['sysctls']['net.ipv4.ip_unprivileged_port_start'], '0')
            self.assertEqual(services['livekit']['command'][-2:], ['--node-ip', ip])
            self.assertEqual(services['gateway']['environment']['OIDC_ISSUER'], auth)
            self.assertEqual(services['gateway']['environment']['SSL_CERT_FILE'], '/run/auth/root.crt')
            self.assertTrue(any('root.crt' in volume for volume in services['gateway']['volumes']))
            caddyfile = (state / 'Caddyfile').read_text()
            self.assertEqual(caddyfile.count('tls internal'), 2)
            self.assertNotIn('default_sni', caddyfile)
            runtime = (state / 'runtime-config.js').read_text()
            self.assertIn(app, runtime)
            self.assertIn(auth, runtime)
            output = io.StringIO()
            with redirect_stdout(output):
                deploy.connection_info(state)
            self.assertIn(f'console.example.com and login.example.com to {ip}', output.getvalue())
            self.assertIn('TCP 443', output.getvalue())
            self.assertIn('192.168.1.50:53/udp', output.getvalue())
            self.assertIn('http://192.168.1.50:3000', output.getvalue())
            self.assertIn('/teleop-root-ca.crt', output.getvalue())

    def test_new_lan_deployments_require_two_distinct_hostnames(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            settings = self.settings(lan_ip='192.168.1.50', domain='console.example.com',
                                     auth_domain='login.example.com')
            saved = deploy.deployment_settings(state, settings)
            self.assertEqual(saved, deploy.deployment_settings(state, self.settings()))
            self.assertEqual(saved['lan_ip'], '192.168.1.50')
            self.assertEqual(saved['domain'], 'console.example.com')
            self.assertEqual(saved['auth_domain'], 'login.example.com')
        for args in (self.settings(lan_ip='192.168.1.50', domain='console.example.com'),
                     self.settings(lan_ip='192.168.1.50', domain='same.example.com',
                                   auth_domain='same.example.com')):
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(RuntimeError):
                deploy.deployment_settings(Path(directory), args)

    def test_new_ip_only_lan_deployment_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, \
                self.assertRaisesRegex(RuntimeError, 'IP-only LAN deployments are not supported'):
            deploy.deployment_settings(Path(directory), self.settings(lan_ip='192.168.1.50'))

    def test_existing_ip_only_deployment_is_rejected_before_start(self):
        saved = dict(local=False, lan_ip='192.168.1.50', domain=None, auth_domain=None,
                     project='teleop', media_ip=None, acme_email='', acme_staging=False)
        with tempfile.TemporaryDirectory() as directory, \
                patch('sys.argv', ['deploy.py', '--state', directory, 'start']), \
                patch.object(deploy, 'start') as start:
            state = Path(directory)
            state.chmod(0o700)
            deploy.write(state / 'deployment.json', saved)
            with self.assertRaisesRegex(RuntimeError, 'saved IP-only LAN deployments are no longer supported'):
                deploy.main()
            start.assert_not_called()

    def test_cli_selects_internal_tls_for_lan_domains_without_changing_urls(self):
        urls = []
        for lan in (True, False):
            with self.subTest(lan=lan), tempfile.TemporaryDirectory() as directory:
                argv = ['deploy.py', '--state', directory]
                if lan:
                    argv += ['--lan-ip', '192.168.1.50']
                argv += ['--domain', 'console.example.com', '--auth-domain', 'login.example.com', 'prepare']
                with patch('sys.argv', argv), patch.object(deploy, 'check_project'), \
                        patch.object(deploy, 'prepare'), patch.object(deploy, 'connection_info'), \
                        patch.multiple(deploy, RELEASE_IMAGES=None, LOCAL=False, PUBLIC_TLS=False,
                                       LAN_DOMAIN=False, PROJECT='teleop', MEDIA_IP='', ACME_EMAIL='',
                                       ACME_STAGING=False):
                    Path(directory).chmod(0o700)
                    deploy.main()
                    self.assertEqual(deploy.LAN_DOMAIN, lan)
                    self.assertEqual(deploy.PUBLIC_TLS, not lan)
                    urls.append((deploy.APP, deploy.AUTH))
        self.assertEqual(urls, [
            ('https://console.example.com', 'https://login.example.com'),
            ('https://console.example.com', 'https://login.example.com'),
        ])

    def test_lan_and_public_generated_application_endpoints_match(self):
        snapshots = []
        app = 'https://console.example.com'
        auth = 'https://login.example.com'
        for lan in (True, False):
            with self.subTest(lan=lan), tempfile.TemporaryDirectory() as directory, \
                    patch.object(deploy, 'compose'), \
                    patch.multiple(deploy, LOCAL=False, LAN_DOMAIN=lan, PUBLIC_TLS=not lan,
                                   MEDIA=False, IP='192.168.1.50', APP=app, AUTH=auth,
                                   MEDIA_IP='', ACME_EMAIL='', ACME_STAGING=False):
                state = Path(directory)
                deploy.prepare(state)
                services = json.loads((state / 'compose.json').read_text())['services']
                runtime_text = (state / 'runtime-config.js').read_text().split(' = ', 1)[1]
                runtime = json.loads(runtime_text.rstrip(';\n'))
                gateway = services['gateway']['environment']
                casdoor = (state / 'casdoor.conf').read_text().splitlines()
                snapshots.append({
                    'runtime_urls': {key: runtime[key] for key in
                                     ('gatewayUrl', 'livekitUrl', 'authorizeUrl', 'tokenUrl')},
                    'gateway_urls': {key: gateway[key] for key in
                                     ('OIDC_ISSUER', 'OIDC_JWKS_URL', 'ALLOWED_ORIGINS')},
                    'casdoor_origins': tuple(line for line in casdoor
                                             if line.startswith(('origin = ', 'originFrontend = '))),
                    'caddy_routes': tuple(line for line in (state / 'Caddyfile').read_text().splitlines()
                                          if line.startswith((app + ' {', auth + ' {',
                                                              '  @gateway path '))),
                })
        self.assertEqual(snapshots[0], snapshots[1])

    def test_acme_settings_are_pinned_and_lan_does_not_use_acme(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            saved = deploy.deployment_settings(state, self.settings(
                domain='console.example.com', auth_domain='auth.example.com',
                acme_email='ops@example.com', acme_staging=True))
            self.assertEqual(saved, deploy.deployment_settings(state, self.settings()))
            for changed in (self.settings(acme_staging=False), self.settings(acme_email='other@example.com')):
                with self.assertRaisesRegex(RuntimeError, 'settings changed'):
                    deploy.deployment_settings(state, changed)
        for args in (self.settings(local=True, acme_email='ops@example.com'),
                     self.settings(lan_ip='192.168.1.50', domain='console.example.com',
                                   auth_domain='login.example.com', acme_staging=True)):
            with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(RuntimeError, 'ACME options'):
                deploy.deployment_settings(Path(directory), args)
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'deployment.json').write_text(json.dumps(dict(
                local=False, lan_ip=None, domain='console.example.com',
                auth_domain='auth.example.com', project='teleop', media_ip=None)))
            self.assertNotIn('acme_email', deploy.deployment_settings(state, self.settings()))

    def test_staging_cannot_start_authentication_services(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('sys.argv', ['deploy.py', '--state', directory, '--domain', 'console.example.com',
                                   '--auth-domain', 'auth.example.com', '--acme-staging', 'start']), \
                patch.object(deploy, 'compose') as compose, patch.object(deploy, 'check_project') as check, \
                patch.multiple(deploy, ACME_EMAIL='', ACME_STAGING=False), \
                patch('sys.stderr', io.StringIO()):
            Path(directory).chmod(0o700)
            with self.assertRaises(SystemExit) as error:
                deploy.main()
            self.assertEqual(error.exception.code, 2)
            compose.assert_not_called()
            check.assert_not_called()

    def test_acme_email_rejects_configuration_injection(self):
        self.assertEqual(deploy.acme_email('Ops+tls@EXAMPLE.COM'), 'Ops+tls@example.com')
        for email in ('ops@example.com\n}', 'ops@example.com {', '{$TOKEN}@example.com',
                      'ops@example.com;foo', 'ops@localhost', 'ops@127.0.0.1'):
            with self.subTest(email=email), self.assertRaises(argparse.ArgumentTypeError):
                deploy.acme_email(email)

    def test_state_pins_project_and_issuer_and_requires_explicit_first_address(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with self.assertRaisesRegex(RuntimeError, 'requires'):
                deploy.deployment_settings(state, self.settings())
            initial = deploy.deployment_settings(state, self.settings(local=True, project='isolated'))
            self.assertEqual(initial, deploy.deployment_settings(state, self.settings()))
            for args in (self.settings(domain='changed.test'), self.settings(project='other')):
                with self.assertRaisesRegex(RuntimeError, 'settings changed'):
                    deploy.deployment_settings(state, args)
            self.assertEqual(json.loads((state / 'deployment.json').read_text()), initial)

    def test_invalid_initial_topology_is_rejected_without_writing_state(self):
        invalid = [self.settings(domain='console.test'),
                   self.settings(domain='same.test', auth_domain='same.test'),
                   self.settings(local=True, auth_domain='auth.test'),
                   self.settings(local=True, media_ip='192.0.2.1')]
        for args in invalid:
            with self.subTest(args=args), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(RuntimeError):
                    deploy.deployment_settings(Path(directory), args)
                self.assertFalse((Path(directory) / 'deployment.json').exists())

    def test_domain_and_project_validation_rejects_injection(self):
        self.assertEqual(deploy.domain_name('Console.Example.com'), 'console.example.com')
        for value in ('localhost', 'https://host.test', 'host.test/path', 'host.test:443',
                      'host.test\nfoo', '-bad.test', '127.0.0.1'):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                deploy.domain_name(value)
        for value in ('a b', '../other', 'a\n', 'a' * 42):
            with self.assertRaises(argparse.ArgumentTypeError):
                deploy.project_name(value)

    def test_project_cannot_replace_another_deployment(self):
        with patch.object(deploy, 'run', return_value=argparse.Namespace(stdout='/other/compose.json\n')):
            with self.assertRaisesRegex(RuntimeError, 'another state directory'):
                deploy.check_project(Path('/release'))
        with patch.object(deploy, 'run', return_value=argparse.Namespace(stdout='/release/compose.json\n')):
            deploy.check_project(Path('/release'))

    def test_provisioning_retries_preserve_existing_accounts_and_reject_identity_conflicts(self):
        desired = dict(owner='teleop', name='platform-admin', id='expected', password='initial')
        current = {**desired, 'password': 'changed'}
        with patch.object(deploy, 'request', return_value=dict(status='ok', data=current)) as request:
            deploy.ensure_object(Path('/unused'), 'user', desired, ('id',))
            self.assertEqual(request.call_count, 1)
        with patch.object(deploy, 'request', return_value=dict(status='ok', data={**current, 'id': 'wrong'})):
            with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
                deploy.ensure_object(Path('/unused'), 'user', desired, ('id',))
        with patch.object(deploy, 'request', side_effect=[dict(status='ok', data=None),
                          dict(status='ok', data='Affected'), dict(status='ok', data=current)]) as request:
            deploy.ensure_object(Path('/unused'), 'user', desired, ('id',))
            self.assertEqual(request.call_count, 3)

    def test_local_and_domain_lan_have_correct_trust_and_media(self):
        for local in (True, False):
            ip = '127.0.0.1' if local else '192.168.20.30'
            app = 'http://127.0.0.1:8443' if local else 'https://console.example.com'
            auth = 'http://127.0.0.1:8444' if local else 'https://login.example.com'
            with self.subTest(local=local), tempfile.TemporaryDirectory() as directory, \
                    patch.object(deploy, 'compose'), patch.multiple(deploy, LOCAL=local, PUBLIC_TLS=False,
                    LAN_DOMAIN=not local, MEDIA=not local, IP=ip, APP=app, AUTH=auth):
                state = Path(directory)
                deploy.prepare(state)
                services = json.loads((state / 'compose.json').read_text())['services']
                if local:
                    self.assertNotIn('ports', services['livekit'])
                    self.assertEqual(services['gateway']['network_mode'], 'service:caddy')
                    self.assertIn('http://caddy:8080/api/webhook/livekit', (state / 'livekit.yaml').read_text())
                else:
                    self.assertEqual(services['caddy']['ports'],
                                     [f'{ip}:443:443'])
                    self.assertEqual(services['livekit']['command'][-2:], ['--node-ip', ip])
                    self.assertEqual(services['gateway']['environment']['SSL_CERT_FILE'], '/run/auth/root.crt')
                    self.assertIn('tls internal', (state / 'Caddyfile').read_text())
                    self.assertIn('/teleop-root-ca.crt', (state / 'Caddyfile').read_text())
                    runtime = (state / 'runtime-config.js').read_text()
                    self.assertIn(app, runtime)
                    self.assertIn(auth, runtime)
                    self.assertNotIn('localhost', runtime)
                    self.assertNotIn('127.0.0.1', runtime)
                    self.assertEqual(services['gateway']['environment']['ALLOWED_ORIGINS'],
                                     app)

    def test_lan_connection_instructions_include_both_endpoints_and_client_trust(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.multiple(deploy, LOCAL=False, PUBLIC_TLS=False, LAN_DOMAIN=True, MEDIA=True,
                               IP='192.168.20.30', APP='https://console.example.com',
                               AUTH='https://login.example.com'):
            output = io.StringIO()
            with redirect_stdout(output):
                deploy.connection_info(Path(directory))
            message = output.getvalue()
            self.assertIn('https://console.example.com/api', message)
            self.assertIn('Login: https://login.example.com', message)
            self.assertIn('console.example.com and login.example.com to 192.168.20.30', message)
            self.assertIn('/teleop-root-ca.crt', message)
            self.assertIn("each client's OS/browser", message)
            self.assertIn('TCP 443', message)
            self.assertIn('192.168.20.30:53/udp', message)
            self.assertIn('http://192.168.20.30:3000', message)
            self.assertNotIn('localhost', message)

    def test_start_starts_adguard_only_for_domain_lan(self):
        for lan in (True, False):
            with self.subTest(lan=lan), tempfile.TemporaryDirectory() as directory, \
                    patch.object(deploy, 'compose') as compose, \
                    patch.object(deploy, 'request', return_value={}), \
                    patch.object(deploy, 'configure_dashboard_session'), \
                    patch.multiple(deploy, LOCAL=False, PUBLIC_TLS=not lan, LAN_DOMAIN=lan,
                                   APP='https://console.example.com',
                                   AUTH='https://login.example.com'):
                state = Path(directory)
                (state / 'configured').touch()
                (state / 'bootstrapped').touch()
                if lan:
                    root = state / 'caddy-data/caddy/pki/authorities/local/root.crt'
                    root.parent.mkdir(parents=True)
                    root.write_text('fixture')
                deploy.start(state, {})
                first_start = compose.call_args_list[0].args
                self.assertEqual('adguardhome' in first_start, lan)


if __name__ == '__main__':
    unittest.main()
