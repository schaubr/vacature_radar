import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { APP_NAME } from "../shared/app";

/**
 * The application menu. `t` maps a label key to its text; keys used (menu.*):
 * menu.about/hide/hideOthers/showAll/quit/edit/undo/redo/cut/copy/paste/selectAll/view/reload/toggleDevTools/
 * toggleFullScreen/window/minimize/zoom/closeWindow (src/shared/i18n). Roles keep their behaviour; the labels follow the app language.
 */
export function buildAppMenu(t: (key: string) => string = (k) => k): Menu {
  const label = (key: string, fallback: string): string => {
    const v = t(key);
    return v === key ? fallback : v;
  };
  const view: MenuItemConstructorOptions[] = app.isPackaged
    ? [{ role: "togglefullscreen", label: label("menu.toggleFullScreen", "Toggle Full Screen") }]
    : [
        { role: "reload", label: label("menu.reload", "Reload") },
        { role: "toggleDevTools", label: label("menu.toggleDevTools", "Toggle Developer Tools") },
        { role: "togglefullscreen", label: label("menu.toggleFullScreen", "Toggle Full Screen") },
      ];
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: label("menu.about", `About ${APP_NAME}`) },
        { type: "separator" },
        { role: "hide", label: label("menu.hide", `Hide ${APP_NAME}`) },
        { role: "hideOthers", label: label("menu.hideOthers", "Hide Others") },
        { role: "unhide", label: label("menu.showAll", "Show All") },
        { type: "separator" },
        { role: "quit", label: label("menu.quit", `Quit ${APP_NAME}`) },
      ],
    },
    {
      label: label("menu.edit", "Edit"),
      submenu: [
        { role: "undo", label: label("menu.undo", "Undo") },
        { role: "redo", label: label("menu.redo", "Redo") },
        { type: "separator" },
        { role: "cut", label: label("menu.cut", "Cut") },
        { role: "copy", label: label("menu.copy", "Copy") },
        { role: "paste", label: label("menu.paste", "Paste") },
        { role: "selectAll", label: label("menu.selectAll", "Select All") },
      ],
    },
    { label: label("menu.view", "View"), submenu: view },
    { label: label("menu.window", "Window"), role: "window", submenu: [{ role: "minimize", label: label("menu.minimize", "Minimize") }, { role: "zoom", label: label("menu.zoom", "Zoom") }, { role: "close", label: label("menu.closeWindow", "Close Window") }] },
  ];
  return Menu.buildFromTemplate(template);
}
