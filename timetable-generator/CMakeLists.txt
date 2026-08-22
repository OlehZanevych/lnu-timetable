cmake_minimum_required(VERSION 3.20)
project(lnu-timetable-generator LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT MSVC)
  add_compile_options(-Wall -Wextra -Wno-unused-parameter)
  add_compile_options($<$<CONFIG:Release>:-O3>)
endif()

# ── the solver core: portable C++20, no Qt, no third-party dependency ─────────
add_library(tgcore STATIC
  src/core/json.cpp
  src/core/instance_io.cpp
  src/core/state.cpp
  src/core/search.cpp
)
target_include_directories(tgcore PUBLIC src)
find_package(Threads REQUIRED)
target_link_libraries(tgcore PUBLIC Threads::Threads)

# ── the headless runner, which is what the benchmarks drive ───────────────────
add_executable(timetable-solve src/cli/main.cpp)
target_link_libraries(timetable-solve PRIVATE tgcore)

# ── the desktop application ───────────────────────────────────────────────────
option(TG_BUILD_GUI "Build the Qt desktop application" ON)
if(TG_BUILD_GUI)
  find_package(Qt6 6.2 COMPONENTS Widgets Network QUIET)
  if(Qt6_FOUND)
    set(CMAKE_AUTOMOC ON)
    qt_add_executable(timetable-generator
      src/gui/main.cpp
      src/gui/graphql_client.cpp
      src/gui/login_dialog.cpp
      src/gui/main_window.cpp
      src/gui/run_controller.cpp
    )
    target_link_libraries(timetable-generator PRIVATE tgcore Qt6::Widgets Qt6::Network)
    set_target_properties(timetable-generator PROPERTIES
      MACOSX_BUNDLE TRUE
      MACOSX_BUNDLE_BUNDLE_NAME "LNU Timetable Generator"
      MACOSX_BUNDLE_GUI_IDENTIFIER ua.edu.lnu.timetable.generator
      WIN32_EXECUTABLE TRUE)
  else()
    message(STATUS "Qt6 not found — building the core and the headless runner only. "
                   "On macOS: brew install qt, then "
                   "cmake -DCMAKE_PREFIX_PATH=$(brew --prefix qt) ..")
  endif()
endif()
