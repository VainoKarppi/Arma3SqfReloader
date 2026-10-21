// SqfReloader_fnc_addEditorMenu
// Idempotent: adds the "SqfReloader" entries to the Eden Editor Tools menu.

if !(is3DEN) exitWith {false};

if (missionNamespace getVariable ["SqfReloader_var_menuAdded", false]) exitWith {true};
missionNamespace setVariable ["SqfReloader_var_menuAdded", true];

true
