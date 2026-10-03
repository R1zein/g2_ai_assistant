package com.splav.quizclicker

import android.content.Context

/**
 * Одна строка базы ответов.
 *
 * @param key    фраза, которая точно есть в тексте вопроса (по ней узнаём вопрос)
 * @param answer текст правильного варианта
 * @param slot   номер варианта сверху (1..4) — запасной способ, если текст не найден
 */
data class Answer(val key: String, val answer: String, val slot: Int) {
    val normKey: String = Answers.normalize(key)
    val normAnswer: String = Answers.normalize(answer)
}

object Answers {

    private const val PREFS = "quiz_clicker"
    private const val KEY_TEXT = "answers_text"

    /**
     * Ответы по скриншотам викторины про ФК «СПЛАВ».
     * Формат строки: фраза из вопроса | правильный ответ | номер варианта (1-4)
     */
    val DEFAULT_TEXT = """
        официальная дата основания | 30 сентября | 3
        против какой команды | Сатурн | 2
        каким счётом завершилась первая игра | 6:7 | 4
        не рассматривалось при создании | Монолит | 2
        автором самого первого гола | Роман Гирник | 4
        самой крупной за первый год | 12:1 над «Олимпиком» | 3
        является президентом клуба | Пейман Габибов | 2
        больше всего голевых передач | Павел Коломиец | 3
        лучшим бомбардиром | Роман Гирник | 4
        сколько всего официальных матчей | 46 | 4
    """.trimIndent()

    /** Слова на кнопке отправки и на ней же после отправки. */
    val SUBMIT_LABELS = listOf("отправить", "ответить", "submit")
    val SUBMITTED_LABELS = listOf("отправлено", "submitted")

    /** Нижний регистр, ё→е, только буквы/цифры/двоеточие — так кавычки и пробелы не мешают сравнению. */
    fun normalize(s: CharSequence): String {
        val sb = StringBuilder(s.length)
        for (ch in s) {
            val c = ch.lowercaseChar()
            when {
                c == 'ё' -> sb.append('е')
                c.isLetterOrDigit() || c == ':' -> sb.append(c)
            }
        }
        return sb.toString()
    }

    fun parse(text: String): List<Answer> = text.lines().mapNotNull { line ->
        val trimmed = line.trim()
        if (trimmed.isEmpty() || trimmed.startsWith("#")) return@mapNotNull null
        val parts = trimmed.split("|").map { it.trim() }
        if (parts.size < 2 || parts[0].isEmpty() || parts[1].isEmpty()) return@mapNotNull null
        val slot = parts.getOrNull(2)?.toIntOrNull()?.takeIf { it in 1..4 } ?: 0
        Answer(parts[0], parts[1], slot)
    }

    fun loadText(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TEXT, null) ?: DEFAULT_TEXT

    fun saveText(context: Context, text: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_TEXT, text).apply()
    }

    fun load(context: Context): List<Answer> = parse(loadText(context))
}
