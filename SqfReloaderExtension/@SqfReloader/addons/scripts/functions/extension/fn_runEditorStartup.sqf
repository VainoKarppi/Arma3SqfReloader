// Run after Eden opens, loads a mission, or creates one. Eden can replace
// missionNamespace during display setup, so repeat registration after it settles.
diag_log format ["[SqfReloader] Eden event: runEditorStartup (is3DEN=%1, missionConfig=%2)", is3DEN, str missionConfigFile];
[] call SqfReloader_fnc_runStartup;
call SqfReloader_fnc_addEditorMenu;

[] spawn {
    uiSleep 0.5;
    // Returning from a playable mission can replace missionNamespace after the Eden
    // EventHandler runs. Call runStartup again here so workspace functions are restored too;
    // reloadFunctions only scans configFile and does not contain these workspace files.
    private _started = [] call SqfReloader_fnc_runStartup;
    diag_log format ["[SqfReloader] Eden namespace refresh (0.5s): startup=%1; example_fnc_add isNil=%2", _started, isNil {missionNamespace getVariable "example_fnc_add"}];

    uiSleep 1;
    _started = [] call SqfReloader_fnc_runStartup;
    diag_log format ["[SqfReloader] Eden namespace refresh (1.5s): startup=%1; example_fnc_add isNil=%2", _started, isNil {missionNamespace getVariable "example_fnc_add"}];

    call SqfReloader_fnc_addEditorMenu;
};
