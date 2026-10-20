// ArmaApi_fnc_apiStart
// Starts the REST API. Synchronous, so the port is bound when this returns.
//   [] call ArmaApi_fnc_apiStart;          // port/host from %LOCALAPPDATA%\ArmaApi\config.json (default 127.0.0.1:8765)
//   [9000, "127.0.0.1"] call ArmaApi_fnc_apiStart;
// Returns the extension message ("REST API listening on http://...") or "" on failure.

params [["_port", 0, [0]], ["_host", "", [""]]];

if !(call ArmaApi_fnc_init) exitWith {""};

private _data = if (_port > 0 && {_host != ""}) then {
    ["ApiStart", [_port, _host]] call ArmaApi_fnc_call;
} else {
    if (_port > 0) then {
        ["ApiStart", [_port]] call ArmaApi_fnc_call;
    } else {
        ["ApiStartFromConfig", []] call ArmaApi_fnc_call;
    };
};

if (isNil "_data") exitWith {""};

ArmaApi_var_apiRunning = true;

private _message = _data param [0, ""];

if (ArmaApi_var_debug) then {diag_log format ["[ArmaApi] API start: %1", _message]};

_message
