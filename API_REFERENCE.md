# API reference

- `cliFlagPresent(args, flag)` checks exact long or short flags.
- `cliFindValue(args, flag)` returns the following argument, or an empty string.
- `cliSubcommand(args)` returns argv[1] when present.
- `cliWriteUsage(program, usage)` writes one bounded usage line through the host boundary.
- `cliExitCodeValid(code)` validates a portable process exit code.

The two `cliWrite*` externs are the only terminal side effects. Hosts must reject untrusted output sizes before forwarding them.

