#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate offline HTML fixtures that mirror the real LNU page markup.

The scraper's ``--offline ROOT`` mode reads ``ROOT/<host>/<path>.html`` instead
of opening a socket, which makes the whole pipeline testable without hammering
lnu.edu.ua.  The pages below are trimmed copies of the real markup (same
headings, same table shapes, same rowspans) for two faculties, chosen so that
the interesting cross-faculty cases are exercised:

  * an AMI course whose owning department ("алгебри, топології та основ
    математики") lives on the Mechmat site,
  * a lecturer page reached from AMI whose employee record belongs to Mechmat,
  * an elective row that must become a ДВ elective group,
  * a shared lecture taught to groups of two specialties, which must be merged
    into a combined working curriculum item.

    python3 tests/make_fixtures.py            # writes tests/fixtures/
"""

from __future__ import annotations

import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "fixtures")

PAGE = """<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><title>{title}</title></head>
<body>
<nav><ul><li><a href="/news">Новини</a></li><li><a href="/contacts">Контакти</a></li></ul></nav>
<header><a href="/">Головна</a></header>
<main>
{body}
</main>
<aside><h4>Останні новини</h4><p>Оголошено донабір на магістерську програму.</p></aside>
<footer><p>© 2026. Всіх прав дотримано. Контакти. Карта сайту. Портал університету.</p></footer>
</body></html>
"""

PADDING = ("<p>Ця сторінка містить офіційну інформацію підрозділу Львівського "
           "національного університету імені Івана Франка. Матеріали публікуються "
           "українською мовою та оновлюються протягом навчального року відповідно "
           "до рішень Вченої ради факультету та розпоряджень деканату.</p>")


def write(host: str, path: str, title: str, body: str) -> None:
    target = os.path.join(ROOT, host, path.strip("/") + ".html")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(PAGE.format(title=title, body=body + PADDING))
    print("wrote", os.path.relpath(target, HERE))


# ---------------------------------------------------------------- university

FACULTY_ITEM = """
<li>
  <h2>{name}</h2>
  <a href="{site}"><img src="/logo.png" alt="{name}"></a>
  <p>Адреса: {address}</p>
  <p>Телефон: {phone}</p>
  <p>E-mail: <a href="mailto:{email}">{email}</a></p>
  <p>Сайт: <a href="{site}">{host}</a></p>
</li>
"""

FACULTIES = [
    dict(name="Економічний факультет", site="https://econom.lnu.edu.ua/",
         host="econom.lnu.edu.ua", email="edean@lnu.edu.ua",
         address="проспект Свободи, 18, м. Львів, 79008, Україна",
         phone="(+38 032) 239-41-68"),
    dict(name="Механіко-математичний факультет", site="https://new.mmf.lnu.edu.ua/",
         host="new.mmf.lnu.edu.ua", email="dmmf@lnu.edu.ua",
         address="вул. Університетська, 1 м. Львів, 79000, Україна",
         phone="(+38 032) 260-00-09, 239-41-74"),
    dict(name="Факультет прикладної математики та інформатики", site="https://ami.lnu.edu.ua",
         host="ami.lnu.edu.ua", email="ami@lnu.edu.ua",
         address="вул. Університетська 1, м. Львів, 79000, Україна",
         phone="(+38 032) 274-01-80, 239-41-86"),
]


def university() -> None:
    body = "<h1>Факультети</h1><ul>" + \
        "".join(FACULTY_ITEM.format(**f) for f in FACULTIES) + "</ul>"
    write("lnu.edu.ua", "/structure/faculties", "Факультети", body)


# ------------------------------------------------------------------ helpers

def departments_page(host: str, faculty_title: str, departments) -> None:
    blocks = []
    for slug, short_name, phone, email, head in departments:
        blocks.append(f"""
<div class="department">
  <h2><a href="/department/{slug}">{short_name}</a></h2>
  <p>Завідує – <a href="/employee/{head}">завідувач</a></p>
  <p><a href="tel:+380322394211">{phone}</a></p>
  <p><a href="mailto:{email}">{email}</a></p>
</div>""")
    write(host, "/about/departments", f"Кафедри - {faculty_title}",
          "<h1>Кафедри</h1>" + "".join(blocks))


def department_page(host: str, slug: str, full_name: str, phone: str, email: str,
                    staff_slugs) -> None:
    links = "".join(f'<li><a href="/employee/{s}">{s}</a></li>' for s in staff_slugs)
    body = f"""
<h1>{full_name}</h1>
<p>Телефон: <a href="tel:+380322394211">{phone}</a></p>
<p>Електронна пошта: <a href="mailto:{email}">{email}</a></p>
<h2>Співробітники</h2>
<ul>{links}</ul>
"""
    write(host, f"/department/{slug}", full_name, body)


def staff_page(host: str, faculty_title: str, blocks) -> None:
    """blocks: [(department slug, department name, [(slug, NAME, position, email)])]"""
    parts = ["<h1>Персонал</h1>", """
<h2>Деканат</h2>
<table><tr><td>декан<a href="/employee/dyyak">ДИЯК Іван Іванович</a></td>
<td>декан</td><td><a href="mailto:ivan.dyyak@lnu.edu.ua">ivan.dyyak@lnu.edu.ua</a></td></tr></table>"""]
    for slug, name, people in blocks:
        rows = "".join(
            f'<tr><td>{position}<a href="/employee/{s}">{full}</a></td>'
            f'<td>{position}</td>'
            f'<td><a href="mailto:{email}">{email}</a></td></tr>'
            for s, full, position, email in people)
        parts.append(f'<h2><a href="/department/{slug}">{name}</a></h2>'
                     f"<table>{rows}</table>")
    write(host, "/about/staff", f"Персонал - {faculty_title}", "".join(parts))


def employee_page(host: str, slug: str, full_name: str, position: str, department_slug: str,
                  department_name: str, degree: str, email: str) -> None:
    body = f"""
<h1>{full_name}</h1>
<p>Посада: {position} <a href="/department/{department_slug}">{department_name}</a></p>
<p>Науковий ступінь: {degree}</p>
<p>Вчене звання: доцент</p>
<p>Телефон (робочий): <a href="tel:+380322394211">(032) 239-42-11</a></p>
<p>Електронна пошта: <a href="mailto:{email}">{email}</a></p>
<h2>Наукові інтереси</h2><p>Математичне моделювання та обчислювальні методи.</p>
"""
    write(host, f"/employee/{slug}", full_name, body)


def academics_page(host: str, level: str, faculty_title: str, entries) -> None:
    blocks = "".join(
        f'<h3><a href="/academics/{level}/{slug}">{label}</a></h3>'
        f'<p>Освітньо-професійна програма.</p>'
        for slug, label in entries)
    heading = "Бакалавр" if level == "bachelor" else "Магістр"
    write(host, f"/academics/{level}", f"{heading} - {faculty_title}",
          f"<h1>{heading}</h1><h2>Навчальні плани та програми курсів за спеціальністю</h2>"
          + blocks)


def curriculum_page(host: str, level: str, slug: str, title: str, semesters) -> None:
    """semesters: [(n, [(subject_html, lect, lab, pract, control)])]"""
    parts = [f"<h1>Навчальний план {title}</h1>"]
    for number, rows in semesters:
        body = "".join(
            f"<tr><td>{subject}</td><td>{lect}</td><td>{lab}</td><td>{pract}</td>"
            f"<td>2:2</td><td>{control}</td></tr>"
            for subject, lect, lab, pract, control in rows)
        parts.append(f"""
<h3>{number}-й семестр</h3>
<table>
<tr><th>Предмет</th><th>Лекцій</th><th>Лаб.</th><th>Практ.</th>
    <th>На тиждень</th><th>Звітність</th></tr>
{body}
</table>""")
    write(host, f"/academics/{level}/{slug}", f"Навчальний план {title}", "".join(parts))


def course_page(host: str, slug: str, name: str, kind: str, department: str,
                plan, lectures=(), practicals=(), labs=()) -> None:
    """plan: [(semester, credits, control)]
    lectures:  [(semester, hours, [(employee_host, slug, label)], 'ПМі-11, ПМі-12')]
    practicals/labs: [(semester, hours, [(group, employee_host, slug, label)])]
    """
    parts = [f"<h1>{name}</h1>", f"<p>Тип: {kind}</p>", f"<p>Кафедра: {department}</p>"]
    if plan:
        rows = "".join(f"<tr><td>{s}</td><td>{c}</td><td>{f}</td></tr>" for s, c, f in plan)
        parts.append("<h2>Навчальний план</h2><table>"
                     "<tr><th>Семестр</th><th>Кредити</th><th>Звітність</th></tr>"
                     f"{rows}</table>")
    if lectures:
        rows = ""
        for semester, hours, lecturers, groups in lectures:
            links = " ".join(
                f'<a href="https://{h}/employee/{s}">{label}</a>' for h, s, label in lecturers)
            rows += (f"<tr><td>{semester}</td><td>{hours}</td>"
                     f"<td>{links}</td><td>{groups}</td></tr>")
        parts.append("<h2>Лекції</h2><table>"
                     "<tr><th>Семестр</th><th>К-сть годин</th><th>Лектор</th>"
                     f"<th>Група(и)</th></tr>{rows}</table>")
    for heading, blocks in (("Практичні", practicals), ("Лабораторні", labs)):
        if not blocks:
            continue
        rows = ""
        for semester, hours, per_group in blocks:
            span = len(per_group)
            for index, (group, employee_host, slug_, label) in enumerate(per_group):
                prefix = (f'<td rowspan="{span}">{semester}</td>'
                          f'<td rowspan="{span}">{hours}</td>') if index == 0 else ""
                rows += (f"<tr>{prefix}<td>{group}</td>"
                         f'<td><a href="https://{employee_host}/employee/{slug_}">{label}</a>'
                         "</td></tr>")
        parts.append(f"<h2>{heading}</h2><table>"
                     "<tr><th>Семестр</th><th>К-сть годин</th><th>Група</th>"
                     f"<th>Викладач(і)</th></tr>{rows}</table>")
    write(host, f"/course/{slug}", name, "".join(parts))


# ----------------------------------------------------------------------- AMI

AMI = "ami.lnu.edu.ua"
AMI_TITLE = "Факультет прикладної математики та інформатики"

AMI_DEPARTMENTS = [
    ("discrete-analysis-intelligent-system", "Дискретного аналізу та інтелектуальних систем",
     "(032) 239-42-11", "kdais@lnu.edu.ua", "prytula"),
    ("programming", "Програмування", "(032) 239-47-57", "programming.dep.ami@lnu.edu.ua",
     "yaroshko"),
]

AMI_STAFF = [
    ("discrete-analysis-intelligent-system", "Кафедра дискретного аналізу та інтелектуальних систем",
     [("prytula", "ПРИТУЛА Микола Миколайович", "завідувач", "mykola.prytula@lnu.edu.ua"),
      ("kvasnytsia", "КВАСНИЦЯ Галина Андріївна", "доцент", "halyna.kvasnytsya@lnu.edu.ua"),
      ("stojko-t-i", "СТОЙКО Тетяна Ігорівна", "асистент", "tetiana.stoyko@lnu.edu.ua"),
      ("yanchynska", "ЯНЧИНСЬКА Олександра Степанівна", "інженер 1 категорії",
       "oleksandra.yanchynska@lnu.edu.ua")]),
    ("programming", "Кафедра програмування",
     [("yaroshko", "ЯРОШКО Сергій Адамович", "завідувач", "serhiy.yaroshko@lnu.edu.ua"),
      ("litynskyi", "ЛІТИНСЬКИЙ Святослав Володимирович", "доцент",
       "svyatoslav.litynskyy@lnu.edu.ua"),
      ("kostiv", "КОСТІВ Василь Ярославович", "старший викладач", "vasyl.kostiv@lnu.edu.ua")]),
]

AMI_EMPLOYEES = [
    ("prytula", "Притула Микола Миколайович", "завідувач",
     "discrete-analysis-intelligent-system", "кафедри дискретного аналізу та інтелектуальних систем",
     "доктор фізико-математичних наук", "mykola.prytula@lnu.edu.ua"),
    ("kvasnytsia", "Квасниця Галина Андріївна", "доцент",
     "discrete-analysis-intelligent-system", "кафедри дискретного аналізу та інтелектуальних систем",
     "кандидат фізико-математичних наук", "halyna.kvasnytsya@lnu.edu.ua"),
    ("stojko-t-i", "Стойко Тетяна Ігорівна", "асистент",
     "discrete-analysis-intelligent-system", "кафедри дискретного аналізу та інтелектуальних систем",
     "доктор філософії", "tetiana.stoyko@lnu.edu.ua"),
    ("yanchynska", "Янчинська Олександра Степанівна", "інженер 1 категорії",
     "discrete-analysis-intelligent-system", "кафедри дискретного аналізу та інтелектуальних систем",
     "", "oleksandra.yanchynska@lnu.edu.ua"),
    ("yaroshko", "Ярошко Сергій Адамович", "завідувач", "programming",
     "кафедри програмування", "кандидат фізико-математичних наук", "serhiy.yaroshko@lnu.edu.ua"),
    ("litynskyi", "Літинський Святослав Володимирович", "доцент", "programming",
     "кафедри програмування", "кандидат фізико-математичних наук",
     "svyatoslav.litynskyy@lnu.edu.ua"),
    ("kostiv", "Костів Василь Ярославович", "старший викладач", "programming",
     "кафедри програмування", "", "vasyl.kostiv@lnu.edu.ua"),
]


def ami() -> None:
    departments_page(AMI, AMI_TITLE, AMI_DEPARTMENTS)
    for slug, short, phone, email, _ in AMI_DEPARTMENTS:
        staff = [p[0] for block in AMI_STAFF if block[0] == slug for p in block[2]]
        department_page(AMI, slug, "Кафедра " + short[0].lower() + short[1:], phone, email, staff)
    staff_page(AMI, AMI_TITLE, AMI_STAFF)
    for args in AMI_EMPLOYEES:
        employee_page(AMI, *args)

    academics_page(AMI, "bachelor", AMI_TITLE, [
        ("curriculum-education", "014.09 Середня освіта (Інформатика)"),
        ("curriculum-applied-mathematics", "113 Прикладна математика"),
    ])
    academics_page(AMI, "master", AMI_TITLE, [
        ("curriculum-education-master", "014 Середня освіта (інформатика)"),
    ])

    link = '<a href="/course/{slug}">{name}</a>'
    curriculum_page(AMI, "bachelor", "curriculum-education", "Середня освіта (Інформатика)", [
        (1, [
            (link.format(slug="alhebra-ta-heometriia-2", name="Алгебра та геометрія"),
             32, "–", 32, "Іспит"),
            (link.format(slug="prohramuvannia", name="Програмування"), 32, 32, "–", "Іспит"),
        ]),
        (7, [
            (link.format(slug="metodyka-navchannia", name="Методика навчання інформатики"),
             32, "–", 16, "Іспит"),
            ("Дисципліна на вибір 1:"
             + link.format(slug="dynamichni-modeli", name="Динамічні моделі та методи прийняття рішень")
             + " "
             + link.format(slug="modeliuvannia-protsesiv", name="Моделювання економіко-екологічних процесів"),
             16, "–", 16, "Залік"),
        ]),
    ])
    curriculum_page(AMI, "bachelor", "curriculum-applied-mathematics", "Прикладна математика", [
        (1, [
            (link.format(slug="alhebra-ta-heometriia-2", name="Алгебра та геометрія"),
             32, "–", 32, "Іспит"),
            # Exclusive to this specialty: it is what tells the builder that
            # ПМі-11/ПМі-12/ПМі-41 are Прикладна математика groups.
            (link.format(slug="chyselni-metody", name="Чисельні методи"), 32, 32, "–", "Іспит"),
        ]),
        (7, [
            (link.format(slug="rivniannia-matfizyky", name="Рівняння математичної фізики"),
             32, "–", 16, "Іспит"),
            ("Дисципліна на вибір 1:"
             + link.format(slug="dynamichni-modeli", name="Динамічні моделі та методи прийняття рішень")
             + " "
             + link.format(slug="modeliuvannia-protsesiv", name="Моделювання економіко-екологічних процесів"),
             16, "–", 16, "Залік"),
        ]),
    ])
    curriculum_page(AMI, "master", "curriculum-education-master",
                    "Середня освіта (інформатика) - Магістр", [
        (2, [
            (link.format(slug="kursova-robota-so", name="Курсова робота"), "–", "–", "–",
             "Диф. залік"),
            ("Дисципліна на вибір 1:"
             + link.format(slug="dynamichna-teoriia-informatsii-so", name="Динамічна теорія інформації")
             + " "
             + link.format(slug="modeli-statystychnoho-navchannia-so", name="Моделі статистичного навчання"),
             32, 32, "–", "Залік"),
        ]),
    ])

    # Owned by a Mechmat department -> exercises cross-faculty matching. The
    # lecture is shared by ПМі-11/ПМі-12 (Прикладна математика) and ПМо-11
    # (Середня освіта), so the two working items must be combined.
    course_page(AMI, "alhebra-ta-heometriia-2", "Алгебра та геометрія", "Нормативний",
                "алгебри, топології та основ математики",
                plan=[(1, 5, "Іспит")],
                lectures=[(1, 32, [("new.mmf.lnu.edu.ua", "brydun", "доцент Бридун В. Л.")],
                           "ПМі-11, ПМі-12, ПМо-11")],
                practicals=[(1, 32, [
                    ("ПМі-11", "new.mmf.lnu.edu.ua", "brydun", "доцент Бридун В. Л."),
                    ("ПМі-12", "new.mmf.lnu.edu.ua", "maksymyk-k-m", "Максимик К. М."),
                    ("ПМо-11", "new.mmf.lnu.edu.ua", "brydun", "доцент Бридун В. Л."),
                ])])
    course_page(AMI, "prohramuvannia", "Програмування", "Нормативний", "програмування",
                plan=[(1, 6, "Іспит")],
                lectures=[(1, 32, [(AMI, "yaroshko", "доцент Ярошко С. А.")], "ПМо-11")],
                labs=[(1, 32, [("ПМо-11", AMI, "kostiv", "Костів В. Я.")])])
    course_page(AMI, "dynamichni-modeli", "Динамічні моделі та методи прийняття рішень",
                "Вибірковий", "дискретного аналізу та інтелектуальних систем",
                plan=[(7, 3, "Залік")],
                lectures=[(7, 16, [(AMI, "prytula", "професор Притула М. М.")],
                           "ПМі-41, ПМо-41")],
                practicals=[(7, 16, [
                    ("ПМі-41", AMI, "prytula", "професор Притула М. М."),
                    ("ПМо-41", AMI, "kvasnytsia", "доцент Квасниця Г. А."),
                ])])
    course_page(AMI, "modeliuvannia-protsesiv", "Моделювання економіко-екологічних процесів",
                "Вибірковий", "дискретного аналізу та інтелектуальних систем",
                plan=[(7, 3, "Залік")],
                lectures=[(7, 16, [(AMI, "prytula", "професор Притула М. М.")], "ПМі-41")])
    course_page(AMI, "metodyka-navchannia", "Методика навчання інформатики", "Нормативний",
                "програмування",
                plan=[(7, 4, "Іспит")],
                lectures=[(7, 32, [(AMI, "yaroshko", "доцент Ярошко С. А.")], "ПМо-41")],
                practicals=[(7, 16, [("ПМо-41", AMI, "kostiv", "Костів В. Я.")])])
    course_page(AMI, "rivniannia-matfizyky", "Рівняння математичної фізики", "Нормативний",
                "дискретного аналізу та інтелектуальних систем",
                plan=[(7, 4, "Іспит")],
                lectures=[(7, 32, [(AMI, "kvasnytsia", "доцент Квасниця Г. А.")], "ПМі-41")],
                practicals=[(7, 16, [("ПМі-41", AMI, "stojko-t-i", "Стойко Т. І.")])])
    course_page(AMI, "chyselni-metody", "Чисельні методи", "Нормативний", "програмування",
                plan=[(1, 5, "Іспит")],
                lectures=[(1, 32, [(AMI, "litynskyi", "доцент Літинський С. В.")],
                           "ПМі-11, ПМі-12")],
                labs=[(1, 32, [
                    ("ПМі-11", AMI, "litynskyi", "доцент Літинський С. В."),
                    ("ПМі-12", AMI, "kostiv", "Костів В. Я."),
                ])])
    course_page(AMI, "kursova-robota-so", "Курсова робота", "Нормативний", "програмування",
                plan=[(2, 3, "Диф. залік")])
    course_page(AMI, "dynamichna-teoriia-informatsii-so", "Динамічна теорія інформації",
                "Вибірковий", "дискретного аналізу та інтелектуальних систем",
                plan=[(2, 4, "Залік")],
                lectures=[(2, 32, [(AMI, "prytula", "професор Притула М. М.")], "ПМом-11")],
                labs=[(2, 32, [("ПМом-11", AMI, "stojko-t-i", "Стойко Т. І.")])])
    course_page(AMI, "modeli-statystychnoho-navchannia-so", "Моделі статистичного навчання",
                "Вибірковий", "дискретного аналізу та інтелектуальних систем",
                plan=[(2, 4, "Залік")],
                lectures=[(2, 32, [(AMI, "kvasnytsia", "доцент Квасниця Г. А.")], "ПМом-11")])


# ------------------------------------------------------------------- Mechmat

MMF = "new.mmf.lnu.edu.ua"
MMF_TITLE = "Механіко-математичний факультет"

MMF_DEPARTMENTS = [
    ("algebra-topology", "Алгебри, топології та основ математики", "(032) 239-41-74",
     "algebra.dep@lnu.edu.ua", "brydun"),
]

MMF_STAFF = [
    ("algebra-topology", "Кафедра алгебри, топології та основ математики",
     [("brydun", "БРИДУН Володимир Любомирович", "доцент", "volodymyr.brydun@lnu.edu.ua"),
      ("maksymyk-k-m", "МАКСИМИК Катерина Миколаївна", "асистент",
       "kateryna.maksymyk@lnu.edu.ua")]),
]

MMF_EMPLOYEES = [
    ("brydun", "Бридун Володимир Любомирович", "доцент", "algebra-topology",
     "кафедри алгебри, топології та основ математики", "кандидат фізико-математичних наук",
     "volodymyr.brydun@lnu.edu.ua"),
    ("maksymyk-k-m", "Максимик Катерина Миколаївна", "асистент", "algebra-topology",
     "кафедри алгебри, топології та основ математики", "", "kateryna.maksymyk@lnu.edu.ua"),
]


def mechmat() -> None:
    departments_page(MMF, MMF_TITLE, MMF_DEPARTMENTS)
    for slug, short, phone, email, _ in MMF_DEPARTMENTS:
        staff = [p[0] for block in MMF_STAFF if block[0] == slug for p in block[2]]
        department_page(MMF, slug, "Кафедра " + short[0].lower() + short[1:], phone, email, staff)
    staff_page(MMF, MMF_TITLE, MMF_STAFF)
    for args in MMF_EMPLOYEES:
        employee_page(MMF, *args)

    academics_page(MMF, "bachelor", MMF_TITLE, [
        ("curriculum-mathematics", "111 Математика"),
    ])
    link = '<a href="/course/{slug}">{name}</a>'
    curriculum_page(MMF, "bachelor", "curriculum-mathematics", "Математика", [
        (1, [(link.format(slug="linijna-alhebra", name="Лінійна алгебра"), 32, "–", 32, "Іспит")]),
    ])
    course_page(MMF, "linijna-alhebra", "Лінійна алгебра", "Нормативний",
                "алгебри, топології та основ математики",
                plan=[(1, 5, "Іспит")],
                lectures=[(1, 32, [(MMF, "brydun", "доцент Бридун В. Л.")], "Мат-11")],
                practicals=[(1, 32, [("Мат-11", MMF, "maksymyk-k-m", "Максимик К. М.")])])
    # No /academics/master page on purpose: the crawler must skip it gracefully.


# --------------------------------------------------------------------- econom
# Deliberately minimal: only the structure page knows about it, and the site
# itself has no /about/departments — the crawler must log and move on.


def main() -> None:
    university()
    ami()
    mechmat()
    print(f"\nFixtures written to {ROOT}")


if __name__ == "__main__":
    main()
