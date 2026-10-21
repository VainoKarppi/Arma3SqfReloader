// SqfReloader_fnc_runStartup
// Called by the mod's own Cfg3DEN >> EventHandlers >> init (Eden Editor, including the main
// menu "Play" flow) and by the VS Code launcher for missions. Safe to call repeatedly.
//
// 1. loads the extension and registers the callback handler,
// 2. starts the REST server with the port/host from %LOCALAPPDATA%\SqfReloader\config.json,
// 3. runs "<mission>\sqfreloader.ini >> StartupCode" when a mission (or the Eden Editor) defines
//    it, so a project can prepare its own state (missionNamespace defaults, test mission...).

if (!(call SqfReloader_fnc_init)) exitWith {
    diag_log "[SqfReloader] startup: the extension is not loaded (SqfReloader_x64.dll next to arma3_x64.exe?)";
    false
};

private _message = [] call SqfReloader_fnc_apiStart;

if (_message == "") exitWith {
    diag_log "[SqfReloader] startup: the REST API could not be started";
    false
};

diag_log format ["[SqfReloader] startup: %1", _message];

// Optional project hook, e.g. in description.ext:
//   class SqfReloader { StartupCode = "call compile preprocessFileLineNumbers 'dev/setup.sqf';"; };
private _code = getText (missionConfigFile >> "SqfReloader" >> "StartupCode");

if (_code != "") then {
    diag_log "[SqfReloader] startup: running project StartupCode";
    call compile _code;
};

true
