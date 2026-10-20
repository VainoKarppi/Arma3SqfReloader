class CfgPatches {
    class ArmaApi {
        units[] = {};
        weapons[] = {};
        requiredVersion = 2.02;
        requiredAddons[] = {"A3_Functions_F"};
        author = "Razer";
        version = "2.0.7";
        versionStr = "2.0.7";
        versionAr[] = {2, 0, 7};
    };
};

class CfgFunctions {
    class ArmaApi {
        tag = "ArmaApi";

        // recompile = 1 marks the functions the editor may recompile after a save. Lifecycle
        // entry points (init/runStartup) and plain wrappers stay unmarked.
        class Core {
            file = "functions\extension";

            class init {};
            class call { recompile = 1; };
            class callAsync { recompile = 1; };
            class handleCallback { recompile = 1; };
            class handleBatch { recompile = 1; };
            class apiStart { recompile = 1; };
            class apiStop { recompile = 1; };
            class apiStatus { recompile = 1; };
            class diagnose { recompile = 1; };
            class runStartup {};
        };

        class Reload {
            file = "functions\reload";

            class reloadFunctions { recompile = 1; };
            class reloadFunction { recompile = 1; };
            class compileFunction { recompile = 1; };
        };

        class Util {
            file = "functions\util";

            class exec { recompile = 1; };
            class send { recompile = 1; };
            class functionList { recompile = 1; };
            class log { recompile = 1; };
            class frameLoop { recompile = 1; };
            class apiOffline { recompile = 1; };
        };

        class UI {
            file = "functions\ui";

            class addEditorMenu { recompile = 1; };
            class showStatus { recompile = 1; };
        };
    };
};

class Cfg3DEN {
    // Same entry point EdenOnline uses: the engine runs this when the Editor display is
    // created (open a mission, new mission, preview, Play from the main menu), so no -init=
    // launch parameter is needed. Keep all statements on the same line: config.cpp strings
    // cannot contain line breaks.
    class EventHandlers {
        class ArmaApi {
            init = "[] call ArmaApi_fnc_runStartup; call ArmaApi_fnc_addEditorMenu;";
            onMissionNew = "[] call ArmaApi_fnc_runStartup; call ArmaApi_fnc_addEditorMenu;";
            onMissionLoad = "[] call ArmaApi_fnc_runStartup; call ArmaApi_fnc_addEditorMenu;";
            onTerrainNew = "[] call ArmaApi_fnc_addEditorMenu;";
        };
    };
};

class ctrlMenuStrip;
class display3DEN {
    class Controls {
        class MenuStrip : ctrlMenuStrip {
            class Items {
                class Tools {
                    items[] += {"ArmaApi_Status", "ArmaApi_Restart"};
                };

                class ArmaApi_Status {
                    text = "Arma API: Status";
                    picture = "\a3\3DEN\Data\Controls\ctrlMenu\link_ca.paa";
                    action = "[] call ArmaApi_fnc_showStatus;";
                };

                class ArmaApi_Restart {
                    text = "Arma API: Restart server";
                    picture = "\a3\3DEN\Data\Controls\ctrlMenu\link_ca.paa";
                    action = "['restart'] call ArmaApi_fnc_showStatus;";
                };
            };
        };
    };
};
