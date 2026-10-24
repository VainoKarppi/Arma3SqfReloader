// Run after Eden opens, loads a mission, or creates one. Eden can replace
// missionNamespace during display setup, so refresh the API and menu after it settles.
[] call SqfReloader_fnc_runStartup;
call SqfReloader_fnc_addEditorMenu;

[] spawn {
    uiSleep 0.5;
    if (is3DEN) then {
        [] call SqfReloader_fnc_runStartup;
    };
    call SqfReloader_fnc_addEditorMenu;
};
