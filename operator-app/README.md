# MeshRover operator app

The operator's phone: rover status and approval cards from the base, over
Bluetooth only. Approving opens World ID's link in the browser, over the
phone's own mobile data.

```sh
npm install
cd ios && pod install && cd ..   # CocoaPods 1.17+ (1.15 fails on Ruby 4)
# iPhone (Release, no Metro needed):
xcodebuild -workspace ios/MeshRoverOperator.xcworkspace -scheme MeshRoverOperator -configuration Release \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates -derivedDataPath ios/build
xcrun devicectl device install app --device <udid> ios/build/Build/Products/Release-iphoneos/MeshRoverOperator.app
# Android:
cd android && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk
```

Signed with team AX7TC6859N (set in the Xcode project); trust the developer on
the phone once (Settings → General → VPN & Device Management).

The base engine must have Bluetooth on (`spikes/engines.sh` turns it on for
the base only).
