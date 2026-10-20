# ArmaApi test script for the killzonekid callExtension harness.
# Run it with: powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1
#
# The harness understands these lines:
#   "<name>" callExtension "<function>"
#   "<name>" callExtension ["<function>", [<arg>, ...]]
#   freeExtension "<name>"
#   execVM "<script>"
#   exit
# Everything else (sleep, comments, blank lines) is ignored.
#
# "exit" is the last line on purpose: the harness keeps reading commands from the
# console after a script finishes, which would leave the process alive forever when it
# runs with redirected input.

# Sync round trip, no arguments.
"ArmaApi" callExtension "Version";

sleep 1;

# Argument binding: the SQF literal "harness" arrives as the string parameter.
"ArmaApi" callExtension ["Ping", ["harness"]];

sleep 1;

# Error path: an unknown method answers ["ERROR",[...]] with return code 1.
"ArmaApi" callExtension ["NoSuchMethod", []];

sleep 1;

# Starts the REST API with the port/host from %LOCALAPPDATA%\ArmaApi\config.json.
"ArmaApi" callExtension ["ApiStartFromConfig", []];

sleep 1;

"ArmaApi" callExtension ["ApiPort", []];

sleep 1;

# Callback path: queued messages are delivered as ExtensionCallback invocations.
"ArmaApi" callExtension ["Reload", [""]];

sleep 2;

freeExtension "ArmaApi";

exit
