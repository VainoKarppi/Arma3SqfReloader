// ArmaApi_fnc_exec
// Runs SQF code locally, right now, and returns the result.
// Call it from a scheduled environment (spawn/call in a script), e.g.
//   _result = ["player setDamage 0; count allPlayers"] call ArmaApi_fnc_exec;
// The REST /api/eval endpoint does the same remotely: the pushed code is compiled
// and executed by ArmaApi_fnc_handleCallback on the game/editor thread.

params [["_code", "", [""]]];

if (_code isEqualTo "") exitWith {nil};

private _compiled = compile _code;

if (isNil "_compiled") exitWith {nil};

call _compiled
