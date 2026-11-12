#!/usr/bin/env python3
"""Exercise fresh LAN HTTPS provisioning from an independent Docker client.

Uses an isolated network with an IP-address certificate and no host ports.
The LAN address is allocated by Docker; existing deployments are untouched.
Requires Docker Compose v2 and Python 3. No browser CA store is changed.
"""
import importlib.util
import argparse
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deployment', ROOT / 'infra/scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

CLIENT = r'''
import json, pathlib, ssl, sys, urllib.error, urllib.request
ns = {'__name__': 'lan_client', '__file__': '/repo/infra/scripts/deploy.py'}
exec(compile(pathlib.Path(ns['__file__']).read_text(), ns['__file__'], 'exec'), ns)
data = json.load(sys.stdin)
ns.update(LOCAL=False, PUBLIC_TLS=False, APP=data['app'], AUTH=data['auth'])
state = pathlib.Path('/state')
try:
    if data.get('inspect'):
        # The default client trust store must reject this private CA.
        try:
            urllib.request.urlopen(data['app'] + '/healthz', timeout=10)
        except urllib.error.URLError as error:
            assert isinstance(error.reason, ssl.SSLCertVerificationError), type(error.reason)
        else:
            raise RuntimeError('untrusted LAN certificate was accepted')
        context = ssl.create_default_context(cafile=str(state / 'root.crt'))
        def fetch(path):
            return urllib.request.urlopen(data['app'] + path, context=context, timeout=10)
        with fetch('/') as response:
            assert response.status == 200 and b'<html' in response.read().lower()
        with fetch('/runtime-config.js') as response:
            public = response.read().decode()
            assert data['app'] in public and data['auth'] in public
            assert '127.0.0.1' not in public and 'localhost' not in public
        with fetch('/teleop-root-ca.crt') as response:
            assert response.read() == (state / 'root.crt').read_bytes()
            assert 'attachment' in response.headers['Content-Disposition']
        try:
            fetch('/root.key')
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise RuntimeError('CA private key route exposed')
        result = {'checked': True}
    else:
        result = ns['request'](state, *data['args'], **data['kwargs'])
    print(json.dumps({'ok': True, 'result': result}))
except (OSError, RuntimeError, AssertionError) as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', type=Path, help='test a prebuilt release without compiling')
    args = parser.parse_args()
    if args.images:
        deploy.RELEASE_IMAGES = deploy.load_release_images(args.images)
    name = 'teleop-lan-test-' + uuid.uuid4().hex[:10]
    client = name + '-client'
    deploy.PROJECT = name
    network_created = client_started = prepared = False
    with tempfile.TemporaryDirectory(prefix=name + '-', dir='/tmp') as directory:
        state = Path(directory).resolve()
        try:
            deploy.run(['docker', 'network', 'create', name], stdout=subprocess.DEVNULL)
            network_created = True
            network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', name]))[0]
            subnet = ipaddress.ip_network(network['IPAM']['Config'][0]['Subnet'])
            # Docker permits static endpoint IPs only on explicitly configured
            # subnets. Reuse its allocation, avoiding a hard-coded test subnet.
            deploy.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL)
            deploy.run(['docker', 'network', 'create', '--subnet', str(subnet), name],
                       stdout=subprocess.DEVNULL)
            deploy.IP = deploy.lan_address(str(subnet.network_address + 10))
            deploy.APP = f'https://{deploy.IP}:8443'
            deploy.AUTH = f'https://{deploy.IP}:8444'
            deploy.LOCAL, deploy.PUBLIC_TLS, deploy.MEDIA = False, False, True
            values = deploy.prepare(state)
            config = json.loads((state / 'compose.json').read_text())
            # A real, separate client reaches the same LAN IP as the services.
            # Host port binding/firewall behavior remains a fresh-host check.
            for service in config['services'].values():
                service.pop('ports', None)
            config['networks'] = {'default': {'external': True, 'name': name}}
            config['services']['caddy']['networks'] = {'default': {'ipv4_address': deploy.IP}}
            deploy.write(state / 'compose.json', config)
            prepared = True
            if deploy.RELEASE_IMAGES is None:
                deploy.build(state)
            deploy.run(['docker', 'run', '-d', '--name', client, '--network', name,
                        '--user', f'{os.getuid()}:{os.getgid()}',
                        '-v', f'{ROOT}:/repo:ro', '-v', f'{state}:/state:ro',
                        'python:3.12-alpine', 'sleep', 'infinity'], stdout=subprocess.DEVNULL)
            client_started = True

            def remote_request(_state, *args, inspect=False, **kwargs):
                data = dict(app=deploy.APP, auth=deploy.AUTH, args=args, kwargs=kwargs, inspect=inspect)
                # Provider credentials and tokens travel only over stdin/stdout pipes,
                # never in command arguments or test logs.
                result = deploy.run(['docker', 'exec', '-i', client, 'python3', '-c', CLIENT],
                                    input=json.dumps(data), capture_output=True, text=True)
                response = json.loads(result.stdout)
                if not response['ok']:
                    raise RuntimeError(response['error'])
                return response['result']

            deploy.request = remote_request
            deploy.start(state, values)
            deploy.verify(state, values)
            remote_request(state, inspect=True)
            deploy.connection_info(state)
            root = (state / 'root.crt').read_bytes()
            original_secrets = (state / 'secrets.json').read_bytes()
            deploy.start(state, values)
            deploy.verify(state, values)
            assert root == (state / 'root.crt').read_bytes(), 'restart changed the client trust anchor'
            assert original_secrets == (state / 'secrets.json').read_bytes(), 'restart changed credentials'
            print('PASS: separate LAN client, IP TLS/trust rejection, webpage/API, PKCE, CA download, restart.')
        finally:
            if client_started:
                deploy.run(['docker', 'rm', '-f', client], stdout=subprocess.DEVNULL)
            if prepared:
                deploy.compose(state, 'down', '--volumes', '--remove-orphans')
            if network_created:
                deploy.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
