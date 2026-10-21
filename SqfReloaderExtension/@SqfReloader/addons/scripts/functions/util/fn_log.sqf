// SqfReloader_fnc_log
// Writes a line to the extension log (%LOCALAPPDATA%\SqfReloader\logs\SqfReloader.log).
// ["message"] call SqfReloader_fnc_log

params [["_message", "", [""]]];

diag_log format ["[SqfReloader] %1", _message];

if (SqfReloader_var_ready) then {
    ["Log", [_message]] call SqfReloader_fnc_call;
};

true
