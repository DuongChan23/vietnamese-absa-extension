"""Locate a Windows JDK before PyJNIus starts the embedded JVM."""

import os
from pathlib import Path
import shutil
import sys


def _jdk_home(value):
    home = Path(os.path.expandvars(value.strip().strip('"'))).expanduser().resolve()
    if home.name.lower() == 'bin':
        home = home.parent
    executables = all((home/'bin'/name).is_file() for name in ('java.exe', 'javac.exe'))
    jvm = any((home/relative).is_file() for relative in (
        'bin/server/jvm.dll', 'bin/client/jvm.dll',
        'jre/bin/server/jvm.dll', 'jre/bin/client/jvm.dll',
    ))
    return home if executables and jvm else None


def _installed_jdks():
    # PATH takes priority over these bounded, conventional install locations.
    roots = []
    for variable in ('ProgramFiles', 'ProgramFiles(x86)'):
        if base := os.getenv(variable):
            roots.extend(Path(base)/vendor for vendor in ('Eclipse Adoptium', 'Java', 'Microsoft'))
    if user := os.getenv('USERPROFILE'):
        roots.append(Path(user)/'.jdks')
    for root in roots:
        try:
            yield from sorted(root.iterdir(), reverse=True)
        except OSError:
            continue


def configure_java():
    """Set JAVA_HOME for this process only; keep explicit user choices first.

    Windows PyJNIus does not infer JAVA_HOME from java.exe on PATH, although
    `java -version` succeeds. Other platforms keep PyJNIus native discovery.
    """
    if sys.platform != 'win32':
        return os.getenv('JAVA_HOME')

    for variable in ('JAVA_HOME', 'JDK_HOME'):
        if value := os.getenv(variable):
            home = _jdk_home(value)
            if home is None:
                raise RuntimeError(
                    f'{variable} does not point to a complete JDK: {value}. '
                    'Set it to the JDK folder containing bin/java.exe, bin/javac.exe and jvm.dll.'
                )
            os.environ['JAVA_HOME'] = str(home)
            return str(home)

    for executable in ('java', 'javac'):
        if location := shutil.which(executable):
            # Resolve javapath/symlink launchers before looking for the JVM.
            home = _jdk_home(str(Path(location).resolve().parent.parent))
            if home is not None:
                os.environ['JAVA_HOME'] = str(home)
                return str(home)

    for candidate in _installed_jdks():
        if home := _jdk_home(str(candidate)):
            os.environ['JAVA_HOME'] = str(home)
            return str(home)

    raise RuntimeError(
        'No complete Java JDK found for VnCoreNLP. Install a JDK and add its bin folder '
        'to PATH, or set JAVA_HOME to the JDK folder, then restart the backend.'
    )
