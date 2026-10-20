// ArmaApi_fnc_log
// Writes a line to the extension log (%LOCALAPPDATA%\ArmaApi\logs\ArmaApi.log).
// ["message"] call ArmaApi_fnc_log

params [["_message", "", [""]]];

diag_log format ["[ArmaApi] %1", _message];

if (ArmaApi_var_ready) then {
    ["Log", [_message]] call ArmaApi_fnc_call;
};

true
