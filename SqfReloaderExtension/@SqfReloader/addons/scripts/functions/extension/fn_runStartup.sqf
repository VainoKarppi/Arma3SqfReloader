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

// The extension writes the $PBOPREFIX$ of every workspace addon to its config, so reloads can
// resolve a tag to the addon folder name (tag "example" lives in "z\example\addons\instance").
private _config = ["ApiPboPrefixes", []] call SqfReloader_fnc_call;
private _pairs = [];
private _prefixes = [];

{
    private _value = _x;
    while {_value isEqualType []} do {_value = _value param [0, ""]};
    if !(_value isEqualType "") then {continue};
    private _prefix = toLower ((_value splitString "/") joinString "\");
    private _segments = _prefix splitString "\";
    _segments = _segments select {_x != ""};
    private _root = toLower (_segments param [0, ""]);
    private _tag = toLower ((if (_root in ["z", "x"]) then {_segments param [1, ""]} else {_segments param [0, ""]}));
    private _name = toLower (_segments param [(count _segments) - 1, ""]);

    if (_tag != "" && {_name != ""}) then {
        // ["tag", "instance"] and ["tag", "tag"] so both the mounted folder and the tag work.
        _pairs pushBack [_tag, _name];
        _pairs pushBack [_tag, _tag];
        _pairs pushBack [_tag, "main"];
        _prefixes pushBack [_tag, _prefix];
    };
} forEach (if (isNil "_config") then {[]} else {_config});

missionNamespace setVariable ["SqfReloader_var_addonNames", _pairs];
missionNamespace setVariable ["SqfReloader_var_addonPrefixes", _prefixes];
diag_log format ["[SqfReloader] startup: configured addon prefixes %1", _prefixes];

// Make custom mod functions callable by name in Eden's debug console immediately.
private _registered = [] call SqfReloader_fnc_reloadFunctions;
diag_log format ["[SqfReloader] startup: registered %1 custom CfgFunctions", _registered];

// Eden replaces parts of missionNamespace while the editor display is being constructed.
// Re-run the registration once the display has settled so functions are present on the
// first editor open, before the developer needs to save a file.
if (is3DEN) then {
    [] spawn {
        uiSleep 0.5;
        private _editorRegistered = [] call SqfReloader_fnc_reloadFunctions;
        diag_log format ["[SqfReloader] Eden startup: registered %1 custom CfgFunctions", _editorRegistered];
    };
};

// Optional project hook, e.g. in description.ext:
//   class SqfReloader { StartupCode = "call compile preprocessFileLineNumbers 'dev/setup.sqf';"; };
private _code = getText (missionConfigFile >> "SqfReloader" >> "StartupCode");

if (_code != "") then {
    diag_log "[SqfReloader] startup: running project StartupCode";
    call compile _code;
};

true
