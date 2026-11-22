const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('coSightDesktop',{providerLogin:provider=>ipcRenderer.invoke('provider-login',provider),chooseProject:()=>ipcRenderer.invoke('choose-project'),chooseDocument:()=>ipcRenderer.invoke('choose-document'),openExternal:url=>ipcRenderer.invoke('open-external',url)});
