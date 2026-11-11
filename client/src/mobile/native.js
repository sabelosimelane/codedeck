import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { PushNotifications } from '@capacitor/push-notifications';
const opaque=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value);
export const isPushConfigured=()=>import.meta.env.VITE_ANDROID_PUSH_CONFIGURED === 'true';
export async function enableNotifications(){
 if(!isPushConfigured())throw new Error('This APK has no Firebase client configuration. Rebuild with google-services.json to enable notifications.');
 if(!Capacitor.isNativePlatform())throw new Error('Notifications require the Android app.');
 const result=await PushNotifications.requestPermissions();
 if(!['granted','denied','prompt','prompt-with-rationale'].includes(result.receive))throw new Error('Invalid notification permission response.');
 if(result.receive==='granted')await PushNotifications.register();
 return {permission:result.receive==='granted'?'granted':result.receive==='denied'?'denied':'prompt',token:null};
}
export async function restoreNotifications(enabled){
 if(typeof enabled!=='boolean')throw new Error('Notification preference must be boolean.');
 if(!enabled)return 'prompt';
 if(!Capacitor.isNativePlatform()||!isPushConfigured())return 'prompt';
 const result=await PushNotifications.checkPermissions();
 if(!['granted','denied','prompt','prompt-with-rationale'].includes(result.receive))throw new Error('Invalid notification permission response.');
 if(result.receive==='granted')await PushNotifications.register();
 return result.receive==='prompt-with-rationale'?'prompt':result.receive;
}
export async function watchNative({onRoute,onToken,onBack,onKeyboard,onError}){
 if(!Capacitor.isNativePlatform())return ()=>{};
 const listeners=[];
 const listen=async(plugin,name,fn)=>listeners.push(await plugin.addListener(name,fn));
 await listen(PushNotifications,'registration',value=>{
  if(typeof value?.value!=='string'||!value.value||value.value.length>4096){onError('Invalid notification registration.');return;}onToken(value.value);
 });
 await listen(PushNotifications,'registrationError',()=>onError('Notification registration failed. Check Firebase configuration and Google Play services.'));
 await listen(PushNotifications,'pushNotificationActionPerformed',value=>{
  const data=value?.notification?.data;
  if(!opaque(data?.instanceId)||!opaque(data?.eventId)){onError('Invalid notification navigation.');return;}
  onRoute({instanceId:data.instanceId,eventId:data.eventId});
 });
 await listen(App,'backButton',onBack);
 await listen(Keyboard,'keyboardDidShow',()=>onKeyboard(true));
 await listen(Keyboard,'keyboardDidHide',()=>onKeyboard(false));
 return ()=>{for(const listener of listeners)listener.remove();};
}
export async function hideKeyboard(){if(Capacitor.isNativePlatform())await Keyboard.hide();else document.activeElement?.blur();}
export async function showKeyboard(){if(Capacitor.isNativePlatform())await Keyboard.show();}
