import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("prepare_omp", ROOT / "scripts/prepare-omp.py")
prepare_omp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare_omp)


class PrepareOmpPlatformTests(unittest.TestCase):
    def test_linux_x64_target_keeps_its_bun_and_addon_layout(self):
        target = prepare_omp.target_for("Linux", "x86_64")

        self.assertEqual(target, "linux-x64")
        self.assertEqual(
            prepare_omp.bun_asset_for(prepare_omp.read_upstream_config(), target),
            "bun-linux-x64-baseline.zip",
        )
        self.assertEqual(
            prepare_omp.native_addon_names(target),
            ("pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"),
        )

    def test_macos_arm64_selects_darwin_bun_and_addon(self):
        target = prepare_omp.target_for("Darwin", "arm64")

        self.assertEqual(target, "darwin-arm64")
        self.assertEqual(
            prepare_omp.bun_asset_for(prepare_omp.read_upstream_config(), target),
            "bun-darwin-aarch64.zip",
        )
        self.assertEqual(
            prepare_omp.native_addon_names(target),
            ("pi_natives.darwin-arm64.node",),
        )

    def test_unsupported_platform_fails_before_downloading(self):
        with self.assertRaisesRegex(RuntimeError, "darwin-arm64"):
            prepare_omp.target_for("Darwin", "x86_64")


if __name__ == "__main__":
    unittest.main()
