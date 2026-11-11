import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
const state=vi.hoisted(()=>({permission:'denied',listeners:{},register:vi.fn()}));
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true}}));
vi.mock('@capacitor/push-notifications',()=>({PushNotifications:{checkPermissions:async()=>({receive:state.permission}),requestPermissions:async()=>({receive:state.permission}),register:state.register,addListener:async(n,f)=>{state.listeners[n]=f;return {remove:vi.fn()}}}}));
vi.mock('@capacitor/app',()=>({App:{addListener:async()=>({remove:vi.fn()})}}));
vi.mock('@capacitor/keyboard',()=>({Keyboard:{addListener:async()=>({remove:vi.fn()}),hide:vi.fn(),show:vi.fn()}}));
import { enableNotifications,restoreNotifications,watchNative } from '../native';
beforeEach(()=>vi.stubEnv('VITE_ANDROID_PUSH_CONFIGURED','true'));
afterEach(()=>vi.unstubAllEnvs());
describe('native notification boundaries',()=>{
 it('does not register after permission denial',async()=>{expect(await enableNotifications()).toEqual({permission:'denied',token:null});expect(state.register).not.toHaveBeenCalled();});
 it('validates routing data and supports rotated tokens',async()=>{const route=vi.fn(),token=vi.fn(),error=vi.fn();const cleanup=await watchNative({onRoute:route,onToken:token,onBack:vi.fn(),onKeyboard:vi.fn(),onError:error});
 state.listeners.pushNotificationActionPerformed({notification:{data:{instanceId:'instance',eventId:'event'}}});expect(route).toHaveBeenCalledWith({instanceId:'instance',eventId:'event'});
 state.listeners.registration({value:'token'});expect(token).toHaveBeenCalledWith('token');
 state.listeners.pushNotificationActionPerformed({notification:{data:{}}});expect(error).toHaveBeenCalled();cleanup();});
});

it('restores granted registration without prompting',async()=>{vi.stubEnv('VITE_ANDROID_PUSH_CONFIGURED','true');state.permission='granted';state.register.mockClear();await expect(restoreNotifications(true)).resolves.toBe('granted');expect(state.register).toHaveBeenCalledOnce();});

it('does not re-enable registration after explicit unregister',async()=>{state.permission='granted';state.register.mockClear();await restoreNotifications(false);expect(state.register).not.toHaveBeenCalled();});
