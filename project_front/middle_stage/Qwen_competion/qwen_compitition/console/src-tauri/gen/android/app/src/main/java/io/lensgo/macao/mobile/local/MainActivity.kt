package io.lensgo.macao.mobile.local

import android.content.Intent
import android.os.Bundle
import android.content.pm.PackageManager
import android.location.Location
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var tripBridge: LensGoTripBridge? = null
  private var appWebView: WebView? = null
  private val cameraLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult(),
  ) { result ->
    tripBridge?.handleCameraResult(result.resultCode)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    LensGoRuntimeService.start(this)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    tripBridge = LensGoTripBridge(this).also { bridge ->
      webView.addJavascriptInterface(bridge, "LensGoNative")
    }
  }

  fun dispatchLocationToWeb(location: Location) {
    val detail = JSONObject()
      .put("latitude", location.latitude)
      .put("longitude", location.longitude)
      .put("accuracy", location.accuracy)
      .put("recordedAt", location.time)
      .toString()
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('lensgo-native-location',{detail:$detail}))",
        null,
      )
    }
  }

  fun dispatchLocationErrorToWeb(message: String) {
    val encoded = JSONObject.quote(message)
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('lensgo-native-location-error',{detail:$encoded}))",
        null,
      )
    }
  }

  fun dispatchCameraPhotoToWeb(name: String, dataUrl: String) {
    val detail = JSONObject()
      .put("name", name)
      .put("dataUrl", dataUrl)
      .put("savedToGallery", true)
      .toString()
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('lensgo-native-camera-photo',{detail:$detail}))",
        null,
      )
    }
  }

  fun dispatchCameraErrorToWeb(message: String) {
    val encoded = JSONObject.quote(message)
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('lensgo-native-camera-error',{detail:$encoded}))",
        null,
      )
    }
  }

  fun dispatchCameraCancelledToWeb() {
    appWebView?.post {
      appWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('lensgo-native-camera-cancelled'))",
        null,
      )
    }
  }

  fun launchCamera(intent: Intent) {
    cameraLauncher.launch(intent)
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    when (requestCode) {
      LensGoTripBridge.LOCATION_PERMISSION_REQUEST -> {
        if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
          tripBridge?.startLocationUpdatesAfterPermission()
        } else {
          dispatchLocationErrorToWeb("未获得定位权限，无法开始行程")
        }
      }
      LensGoTripBridge.CAMERA_STORAGE_PERMISSION_REQUEST -> {
        if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
          tripBridge?.startCameraCaptureAfterPermission()
        } else {
          dispatchCameraErrorToWeb("未获得保存照片权限，无法拍照并保存到系统相册")
        }
      }
    }
  }

  override fun onDestroy() {
    tripBridge?.shutdown()
    tripBridge = null
    appWebView = null
    super.onDestroy()
  }
}
