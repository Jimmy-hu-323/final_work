package io.lensgo.macao.mobile.local

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the in-process LensGo runtime alive when the Activity is temporarily
 * backgrounded (for example while the user opens the camera or another app).
 *
 * The service contains no credentials and exposes no Android component to
 * other apps. Android still remains free to stop it under platform limits.
 */
class LensGoRuntimeService : Service() {
  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    startForeground(NOTIFICATION_ID, buildNotification())
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(
      CHANNEL_ID,
      "LensGo 本地运行时",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "保持本地旅行助手、模型请求和媒体任务可用"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java)
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("LensGo 本地模式")
      .setContentText("旅行助手正在这台手机上运行")
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "lensgo_local_runtime"
    private const val NOTIFICATION_ID = 1001

    fun start(context: Context) {
      ContextCompat.startForegroundService(
        context,
        Intent(context, LensGoRuntimeService::class.java),
      )
    }
  }
}
