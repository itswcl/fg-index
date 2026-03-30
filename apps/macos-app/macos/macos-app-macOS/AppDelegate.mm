#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  NSLog(@"AppDelegate: applicationDidFinishLaunching");
  self.moduleName = @"macos-app";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.automaticallyLoadReactNativeWindow = YES;

#if DEBUG
  [[RCTBundleURLProvider sharedSettings] setJsLocation:@"localhost:8082"];
#endif

  [super applicationDidFinishLaunching:notification];

  // Configure the window size to accommodate the Fear & Greed / VIX cards cleanly
  if (self.window) {
    [self.window setMinSize:NSMakeSize(368, 208)];
    [self.window setMaxSize:NSMakeSize(368, 208)];
    [self.window setContentSize:NSMakeSize(368, 208)];
    [self.window setTitle:@"Fear & Greed & VIX index"];
    self.window.styleMask &= ~NSWindowStyleMaskResizable;
  }
}

- (NSURL *)bundleURL
{
  NSLog(@"AppDelegate: bundleURL called");
#if DEBUG
  return [NSURL URLWithString:@"http://localhost:8082/index.bundle?platform=macos&dev=true"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
