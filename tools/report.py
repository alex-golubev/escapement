#!/usr/bin/env python3
"""How the checks in this directory talk to whoever ran them.

One copy rather than one per script: each of them ends the same way, with a
per-file verdict on stdout and, if something failed, what to do about it on
stderr. The ordering below is the whole reason this is a function.
"""

import sys


def advise(*lines):
    """What to do about a failure — on stderr, and after the per-file report.

    Apart from those lines because it is advice about the run rather than about
    any one file, and because the wrong advice on a silent build problem costs
    more than none.

    The flush is not decoration. stdout is block-buffered into a pipe and stderr
    is not, so without it the advice arrives before the failure it is about —
    and a CI log is read from the bottom.
    """
    sys.stdout.flush()
    print("\n" + "\n".join(lines), file=sys.stderr)
