// SqfReloader_fnc_runStartup
// Called by the mod's own Cfg3DEN >> EventHandlers >> init (Eden Editor, including the main
// menu "Play" flow) and by the VS Code launcher for missions. Safe to call repeatedly.
//
// 1. loads the extension and registers the callback handler,
// 2. starts the REST server with the port/host from %LOCALAPPDATA%\SqfReloader\config.json,
// 3. runs "<mission>\sqfreloader.ini >> StartupCode" when a mission (or the Eden Editor) defines
//    it, so a project can prepare its own state (missionNamespace defaults, test mission...).

diag_log format ["[SqfReloader] startup: begin (is3DEN=%1, missionConfig=%2)", is3DEN, str missionConfigFile];

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

// The workspace's loose config.cpp is not necessarily present in configFile, so CfgFunctions
// scans alone cannot restore functions after Arma replaces missionNamespace. The extension's
// config contains each workspace function name and its file-patched z: path.
private _workspaceFunctions = ["ApiWorkspaceFunctions", []] call SqfReloader_fnc_call;
private _workspaceRegistered = 0;
diag_log format ["[SqfReloader] startup: workspace function API returned type=%1 value=%2", typeName _workspaceFunctions, str _workspaceFunctions];

// SqfReloader_fnc_call returns the API's single array value inside its own data array.
// Remove that envelope so each loop item is exactly [functionName, ArmaPath].
if (_workspaceFunctions isEqualType [] && {count _workspaceFunctions == 1} && {(_workspaceFunctions select 0) isEqualType []}) then {
    _workspaceFunctions = _workspaceFunctions select 0;
};
if !(_workspaceFunctions isEqualType []) then {_workspaceFunctions = []};
diag_log format ["[SqfReloader] startup: processing %1 workspace function entries", count _workspaceFunctions];

{
    if !(_x isEqualType [] && {count _x >= 2}) then {
        diag_log format ["[SqfReloader] startup: ignoring malformed workspace function entry %1", str _x];
        continue;
    };
    private _variable = _x param [0, ""];
    private _source = _x param [1, ""];
    if !(_variable isEqualType "" && {_source isEqualType ""}) then {
        diag_log format ["[SqfReloader] startup: ignoring non-string workspace function entry %1", str _x];
        continue;
    };
    if (_variable isEqualTo "" || {_source isEqualTo ""}) then {continue};
    if !(fileExists _source) then {
        diag_log format ["[SqfReloader] startup: workspace source is missing for %1: %2", _variable, _source];
        continue;
    };

    private _wasNil = isNil {missionNamespace getVariable _variable};
    missionNamespace setVariable [_variable, compile preprocessFileLineNumbers _source];
    _workspaceRegistered = _workspaceRegistered + 1;
    diag_log format ["[SqfReloader] startup: restored workspace function %1 from %2 (previouslyNil=%3, nowNil=%4)", _variable, _source, _wasNil, isNil {missionNamespace getVariable _variable}];
} forEach _workspaceFunctions;
diag_log format ["[SqfReloader] startup: restored %1 workspace function(s) in this missionNamespace", _workspaceRegistered];

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

true
