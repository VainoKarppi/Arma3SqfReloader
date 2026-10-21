// Run after Eden opens, loads a mission, or creates one. Eden can replace
// missionNamespace during display setup, so repeat registration after it settles.
diag_log format ["[SqfReloader] Eden event: runEditorStartup (is3DEN=%1, missionConfig=%2)", is3DEN, str missionConfigFile];
[] call SqfReloader_fnc_runStartup;
call SqfReloader_fnc_addEditorMenu;

[] spawn {
    uiSleep 0.5;
    private _registered = [] call SqfReloader_fnc_reloadFunctions;
    diag_log format ["[SqfReloader] Eden namespace refresh (0.5s): registered %1 custom CfgFunctions; example_fnc_add isNil=%2", _registered, isNil {missionNamespace getVariable "example_fnc_add"}];

    uiSleep 1;
    _registered = [] call SqfReloader_fnc_reloadFunctions;
    diag_log format ["[SqfReloader] Eden namespace refresh (1.5s): registered %1 custom CfgFunctions; example_fnc_add isNil=%2", _registered, isNil {missionNamespace getVariable "example_fnc_add"}];

    call SqfReloader_fnc_addEditorMenu;
};
