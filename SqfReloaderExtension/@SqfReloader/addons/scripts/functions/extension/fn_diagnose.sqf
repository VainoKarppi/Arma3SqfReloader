// SqfReloader_fnc_diagnose
// Prints one log line per fact that can stop the REST API from working.
// [] call SqfReloader_fnc_diagnose

private _lines = [];

_lines pushBack format ["SqfReloader ready: %1", SqfReloader_var_ready];
_lines pushBack format ["Extension version: %1", SqfReloader_var_version];

if (SqfReloader_var_ready) then {
    private _pong = ["Ping", ["diagnose"]] call SqfReloader_fnc_call;
    _lines pushBack format ["Ping: %1", str _pong];

    private _port = ["ApiPort", []] call SqfReloader_fnc_call;
    _lines pushBack format ["API port: %1", str _port];

    private _running = ["ApiIsRunning", []] call SqfReloader_fnc_call;
    _lines pushBack format ["API running: %1", str _running];

    private _url = ["ApiUrl", []] call SqfReloader_fnc_call;
    _lines pushBack format ["API url: %1", str _url];

    private _logDir = ["ApiLogDirectory", []] call SqfReloader_fnc_call;
    _lines pushBack format ["Log directory: %1", str _logDir];
} else {
    _lines pushBack format ["Last error: %1", SqfReloader_var_lastError];
    _lines pushBack "Check that SqfReloader_x64.dll is next to arma3_x64.exe (or arma3server_x64.exe).";
};

_lines pushBack format ["Mod: %1", configName (configFile >> "CfgPatches" >> "SqfReloader")];

{
    diag_log format ["[SqfReloader] %1", _x];
} forEach _lines;

_lines
