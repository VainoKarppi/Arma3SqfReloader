// SqfReloader_fnc_apiStart
// Starts the REST API. Synchronous, so the port is bound when this returns.
//   [] call SqfReloader_fnc_apiStart;          // port/host from %LOCALAPPDATA%\SqfReloader\config.json (default 127.0.0.1:8765)
//   [9000, "127.0.0.1"] call SqfReloader_fnc_apiStart;
// Returns the extension message ("REST API listening on http://...") or "" on failure.

params [["_port", 0, [0]], ["_host", "", [""]]];

if !(call SqfReloader_fnc_init) exitWith {""};

private _data = if (_port > 0 && {_host != ""}) then {
    ["ApiStart", [_port, _host]] call SqfReloader_fnc_call;
} else {
    if (_port > 0) then {
        ["ApiStart", [_port]] call SqfReloader_fnc_call;
    } else {
        ["ApiStartFromConfig", []] call SqfReloader_fnc_call;
    };
};

if (isNil "_data") exitWith {""};

SqfReloader_var_apiRunning = true;

private _message = _data param [0, ""];

if (SqfReloader_var_debug) then {diag_log format ["[SqfReloader] API start: %1", _message]};

_message
