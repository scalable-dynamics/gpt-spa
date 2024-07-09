"use strict";
const { app, ipcMain, shell, BrowserWindow, Tray, Menu, MenuItem, nativeImage, session } = require('electron');
const path = require('path');
const createWindow = () => {
    const win = new BrowserWindow({
        width: 500,
        height: 900,
        scrollBounce: true,
        frame: false,
        autoplayPolicy: 'no-user-gesture-required',
        titleBarStyle: 'hidden',
        webPreferences: {
            //preload: path.join(__dirname, 'preload.js')
        }
    });
    win.setSkipTaskbar(true);
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.loadFile('./index.html');
    win.webContents.openDevTools();
    const { screen } = require('electron');
    const mainScreen = screen.getPrimaryDisplay();
    const dimensions = mainScreen.workAreaSize;
    const { width, height } = dimensions;
    const winWidth = 500;
    win.setPosition(width - winWidth, 0);
    win.setSize(winWidth, height);
    return win;
};
ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.setIgnoreMouseEvents(ignore, options);
});
app.on('window-all-closed', () => {
});
app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
    });
});
const menu = new Menu();
menu.append(new MenuItem({
    label: 'Electron',
    submenu: [{
        role: 'help',
        accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Alt+Shift+I',
        click: () => { console.log('Electron rocks!'); }
    }]
}));
Menu.setApplicationMenu(menu);
app.whenReady().then(() => {
    const win = createWindow();
    const icon = nativeImage.createFromPath('../favicon.ico');
    let tray = new Tray(icon);
    tray.setToolTip('gpt-local');
    tray.setTitle('gpt-spa/local');
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Camera Enabled', type: 'checkbox', checked: true },
        { label: 'Microphone Enabled', type: 'checkbox', checked: true },
        { label: 'Quit', type: 'normal', click: () => { app.quit(); } },
        { label: 'Open', type: 'normal', click: () => { win.show(); } },
        { label: 'Close', type: 'normal', click: () => { win.hide(); } }
    ]);
    win.setMenu(contextMenu);
    tray.setContextMenu(contextMenu);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.includes('/api/')) {
            console.log('onBeforeRequest', details.url);
            callback({ cancel: true });
        }
        else {
            callback({ cancel: false });
        }
    });
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
