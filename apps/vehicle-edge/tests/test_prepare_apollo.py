import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "prepare_apollo", Path(__file__).resolve().parents[1] / "prepare_apollo.py")
prepare_apollo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_apollo)


class PrepareApolloTest(unittest.TestCase):
    def test_overlay_is_idempotent_and_does_not_modify_apollo_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            apollo = Path(directory)
            edge = apollo / "remote-infra/apps/vehicle-edge"
            edge.mkdir(parents=True)
            module = ('python.defaults(python_version = "3.8")\n'
                      'python.toolchain(python_version = "3.8")\n')
            (apollo / "MODULE.bazel").write_text(module)
            (apollo / ".bazelrc").write_text("build --cxxopt=-std=c++17\ntry-import %workspace%/.custom.bazelrc\n")
            wrapper = apollo / "cyber/python/internal/py_cyber.cc"
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text("  apollo::cyber::py_shutdown();\n")
            (wrapper.parent / "BUILD").write_text("# original build\n")
            (edge / "BUILD.apollo").write_text("# local build\n")
            state = edge / ".apollo-local"
            with patch.object(prepare_apollo, "EDGE", edge), patch.object(prepare_apollo, "STATE", state):
                workspace = prepare_apollo.prepare(apollo)
                self.assertEqual(prepare_apollo.prepare(apollo), workspace)
            self.assertEqual((apollo / "MODULE.bazel").read_text(), module)
            self.assertEqual(wrapper.read_text(), "  apollo::cyber::py_shutdown();\n")
            self.assertIn('python_version = "3.10"', (workspace / "MODULE.bazel").read_text())
            self.assertNotIn("try-import", (workspace / ".bazelrc").read_text())
            self.assertIn("Py_BEGIN_ALLOW_THREADS", (workspace / "cyber/python/internal/py_cyber.cc").read_text())
            self.assertTrue((workspace / "cyber/python/internal/BUILD").is_symlink())
            self.assertFalse((workspace / "cyber/python/internal/py_cyber.cc").is_symlink())
            self.assertFalse((workspace / "remote-infra").exists())
