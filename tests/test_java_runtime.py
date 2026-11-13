"""Java discovery regression tests: no Java/ML installation required."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import java_runtime


class JavaRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for context in (
            patch.dict(os.environ, {}, clear=True),
            patch.object(java_runtime.sys, 'platform', 'win32'),
            patch.object(java_runtime.shutil, 'which', return_value=None),
        ):
            context.start()
            self.addCleanup(context.stop)

    def jdk(self, name='jdk-21', jvm='bin/server/jvm.dll'):
        home = self.root/name
        for relative in ('bin/java.exe', 'bin/javac.exe', jvm):
            file = home/relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        return home.resolve()

    def test_missing_java_home_is_inferred_from_java_on_path(self):
        home = self.jdk('JDK with spaces')
        java_runtime.shutil.which.side_effect = lambda name: str(home/'bin/java.exe') if name == 'java' else None
        self.assertEqual(java_runtime.configure_java(), str(home))
        self.assertEqual(os.environ['JAVA_HOME'], str(home))

    def test_explicit_java_home_takes_priority_and_bin_suffix_is_normalized(self):
        home = self.jdk()
        os.environ['JAVA_HOME'] = f'"{home / "bin"}"'
        self.assertEqual(java_runtime.configure_java(), str(home))
        java_runtime.shutil.which.assert_not_called()

    def test_jdk_home_and_java8_layout_are_supported(self):
        home = self.jdk(jvm='jre/bin/server/jvm.dll')
        os.environ['JDK_HOME'] = str(home)
        self.assertEqual(java_runtime.configure_java(), str(home))
        self.assertEqual(os.environ['JAVA_HOME'], str(home))

    def test_runtime_only_java_launcher_does_not_hide_a_valid_javac(self):
        launcher = self.root/'jre/bin/java.exe'
        launcher.parent.mkdir(parents=True)
        launcher.touch()
        home = self.jdk()
        java_runtime.shutil.which.side_effect = lambda name: str(launcher if name == 'java' else home/'bin/javac.exe')
        self.assertEqual(java_runtime.configure_java(), str(home))

    def test_standard_install_location_is_used_without_path_or_environment(self):
        home = self.jdk('Program Files/Eclipse Adoptium/jdk-21')
        os.environ['ProgramFiles'] = str(self.root/'Program Files')
        self.assertEqual(java_runtime.configure_java(), str(home))

    def test_invalid_explicit_home_is_reported_without_silently_using_another_jdk(self):
        os.environ['JAVA_HOME'] = str(self.root/'missing')
        with self.assertRaisesRegex(RuntimeError, 'JAVA_HOME does not point to a complete JDK'):
            java_runtime.configure_java()
        java_runtime.shutil.which.assert_not_called()

    def test_missing_jdk_reports_actionable_error(self):
        with self.assertRaisesRegex(RuntimeError, 'No complete Java JDK found'):
            java_runtime.configure_java()
        self.assertNotIn('JAVA_HOME', os.environ)

    def test_other_platforms_keep_native_discovery(self):
        with patch.object(java_runtime.sys, 'platform', 'linux'):
            self.assertIsNone(java_runtime.configure_java())
        java_runtime.shutil.which.assert_not_called()


if __name__ == '__main__':
    unittest.main()
