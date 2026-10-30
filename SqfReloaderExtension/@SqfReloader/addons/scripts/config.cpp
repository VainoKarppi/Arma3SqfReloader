class CfgPatches {
    class SqfReloader {
        units[] = {};
        weapons[] = {};
        requiredVersion = 2.22;
        requiredAddons[] = {"A3_Functions_F", "3DEN"};
        author = "Razer";
        version = "3.6.6";
        versionStr = "3.6.6";
        versionAr[] = {3, 6, 6};
    };
};

class CfgFunctions {
    class SqfReloader {
        tag = "SqfReloader";

        // Paths are absolute because the addon is mounted as \scripts (prefix "scripts").
        class Core {
            file = "\scripts\functions\extension";

            class init {};
            class call {};
            class callAsync {};
            class handleCallback {};
            class handleBatch {};
            class apiStart {};
            class evalWatch {};
            class apiStop {};
            class apiStatus {};
            class diagnose {};
            class runStartup {};
            class preInit { preInit = 1; };
            class postInit { postInit = 1; };
            class runEditorStartup {};
        };

        class Reload {
            file = "\scripts\functions\reload";

            class reloadFunctions {};
            class reloadFunction {};
            class compileFunction {};
            class runMissionPlayerServerInit {};
        };

        class Util {
            file = "\scripts\functions\util";

            class exec {};
            class send {};
            class functionList {};
            class log {};
            class frameLoop {};
            class apiOffline {};
        };

        class UI {
            file = "\scripts\functions\ui";

            class addEditorMenu {};
            class showStatus {};
        };
    };
};

class Cfg3DEN {
    // Same entry point EdenOnline uses: the engine runs this when the Editor display is
    // created (open a mission, new mission, preview, Play from the main menu), so no -init=
    // launch parameter is needed. Keep all statements on the same line: config.cpp strings
    // cannot contain line breaks.
    class EventHandlers {
        class SqfReloader {
            init = "[] call SqfReloader_fnc_runEditorStartup;";
            onMissionNew = "[] call SqfReloader_fnc_runEditorStartup;";
            onMissionLoad = "[] call SqfReloader_fnc_runEditorStartup;";
            onMissionPreviewEnd = "[] spawn { uiSleep 0.1; diag_log '[SqfReloader] Eden OnMissionPreviewEnd: restoring workspace functions'; [] call SqfReloader_fnc_runEditorStartup; };";
            onTerrainNew = "call SqfReloader_fnc_addEditorMenu;";
        };
    };
};

class ctrlMenuStrip;
class display3DEN {
    class Controls {
        class MenuStrip : ctrlMenuStrip {
            class Items {
                class Tools {
                    items[] += {"SqfReloader_Status", "SqfReloader_Restart"};
                };

                class SqfReloader_Status {
                    text = "SqfReloader: Status";
                    picture = "\a3\3DEN\Data\Controls\ctrlMenu\link_ca.paa";
                    action = "[] call SqfReloader_fnc_showStatus;";
                };

                class SqfReloader_Restart {
                    text = "SqfReloader: Restart server";
                    picture = "\a3\3DEN\Data\Controls\ctrlMenu\link_ca.paa";
                    action = "['restart'] call SqfReloader_fnc_showStatus;";
                };
            };
        };
    };
};
