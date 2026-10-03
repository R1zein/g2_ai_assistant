package com.splav.quizclicker

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** Экран настройки: включение службы, показ стрелки и редактирование базы ответов. */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var arrowButton: Button
    private lateinit var editor: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(16)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        status = TextView(this).apply {
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
        }
        root.addView(status)

        root.addView(TextView(this).apply {
            textSize = 14f
            setPadding(0, dp(8), 0, dp(8))
            text = """
                1. Нажмите «Включить службу» и включите «Quiz Clicker — стрелка».
                   На Android 13+ при ошибке «Ограниченная настройка»: О приложении → ⋮ → «Разрешить ограниченные настройки».
                2. На экране появится зелёная стрелка ▶. Откройте викторину в браузере.
                3. Нажмите стрелку — она станет красной ■ и будет сама жать правильный ответ и «Отправить» на каждом вопросе.
                   Ещё раз нажать — стоп. Стрелку можно перетаскивать: держите её подальше от вариантов ответа.
                4. Долгое нажатие на стрелку копирует весь текст с экрана — пригодится, чтобы добавить новый вопрос.
            """.trimIndent()
        })

        root.addView(button("Включить службу") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })

        arrowButton = button("Показать стрелку") {
            val s = ClickerService.instance
            if (s == null) {
                toast("Сначала включите службу")
            } else {
                if (s.isArrowShown()) { s.stop(); s.hideArrow() } else s.ensureArrow()
            }
            refresh()
        }
        root.addView(arrowButton)

        root.addView(TextView(this).apply {
            textSize = 14f
            setPadding(0, dp(16), 0, dp(4))
            text = "База ответов — по строке на вопрос:\nфраза из вопроса | правильный ответ | номер варианта (1–4)"
        })

        editor = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            gravity = Gravity.TOP or Gravity.START
            minLines = 8
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setHorizontallyScrolling(false)
            setText(Answers.loadText(this@MainActivity))
        }
        root.addView(editor, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button("Сохранить") {
            val list = Answers.parse(editor.text.toString())
            Answers.saveText(this, editor.text.toString())
            toast("Сохранено вопросов: ${list.size}. Перезапустите стрелку.")
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        row.addView(button("По умолчанию") {
            editor.setText(Answers.DEFAULT_TEXT)
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(row)

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.WHITE)
            addView(root)
        })
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val enabled = isServiceEnabled()
        val s = ClickerService.instance
        status.text = when {
            !enabled || s == null -> "Служба выключена"
            s.isRunning() -> "Работает — стрелка красная"
            s.isArrowShown() -> "Готово — нажмите стрелку на экране"
            else -> "Служба включена, стрелка скрыта"
        }
        status.setTextColor(if (enabled && s != null) Color.parseColor("#2E7D32") else Color.parseColor("#C62828"))
        arrowButton.text = if (s?.isArrowShown() == true) "Скрыть стрелку" else "Показать стрелку"
    }

    private fun isServiceEnabled(): Boolean {
        val me = ComponentName(this, ClickerService::class.java).flattenToString()
        val list = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            ?: return false
        return list.split(':').any { it.equals(me, ignoreCase = true) }
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
