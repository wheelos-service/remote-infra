cmake_minimum_required(VERSION 3.16)
project(VehicleEdgeSDK VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
find_package(jsoncpp CONFIG REQUIRED)
find_package(CURL REQUIRED)
find_package(Threads REQUIRED)
find_package(OpenSSL 1.1.1 REQUIRED)
find_package(SQLite3 REQUIRED)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

function(edge_sdk_library name package component)
  add_library(edge_${name} STATIC ${ARGN})
  add_library(VehicleEdge::${name} ALIAS edge_${name})
  set_target_properties(edge_${name} PROPERTIES EXPORT_NAME ${name}
    POSITION_INDEPENDENT_CODE ON)
  target_include_directories(edge_${name} PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)
  target_compile_features(edge_${name} PUBLIC cxx_std_17)
  target_compile_options(edge_${name} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  install(TARGETS edge_${name} EXPORT ${package}Targets
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR} COMPONENT ${component})
endfunction()

edge_sdk_library(state VehicleAuthSDK auth src/common/state_cache.cc)
target_link_libraries(edge_state PUBLIC JsonCpp::JsonCpp Threads::Threads)
edge_sdk_library(config VehicleAuthSDK auth src/common/config.cc)
target_link_libraries(edge_config PUBLIC edge_state CURL::libcurl)
edge_sdk_library(transport VehicleAuthSDK auth src/common/http_client.cc)
target_link_libraries(edge_transport PUBLIC edge_config CURL::libcurl)
edge_sdk_library(auth VehicleAuthSDK auth src/auth/auth_client.cc)
target_link_libraries(edge_auth PUBLIC edge_transport)
edge_sdk_library(teleop VehicleTeleopSDK teleop
  src/teleop/teleop_client.cc src/teleop/media_demand.cc
  src/teleop/media_service.cc src/teleop/encoded_video.cc)
target_sources(edge_teleop PRIVATE src/teleop/control_receiver.cc src/teleop/control_service.cc)
target_link_libraries(edge_teleop PUBLIC edge_auth Threads::Threads OpenSSL::Crypto)
edge_sdk_library(data VehicleDataSDK data src/data/data_client.cc)
target_sources(edge_data PRIVATE src/data/durable_store.cc src/data/health_service.cc
  src/data/task_service.cc src/data/data_service.cc)
target_link_libraries(edge_data PUBLIC edge_auth edge_state SQLite::SQLite3)
edge_sdk_library(runtime VehicleDataSDK data src/data/source_service.cc)
target_link_libraries(edge_runtime PUBLIC edge_data Threads::Threads)
add_library(edge_telemetry INTERFACE)
target_link_libraries(edge_telemetry INTERFACE edge_runtime edge_teleop)

option(EDGE_ENABLE_GSTREAMER "Build camera_gst sample adapter (no capture ownership)" OFF)
if(EDGE_ENABLE_GSTREAMER)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(GStreamer REQUIRED IMPORTED_TARGET
    gstreamer-app-1.0 gstreamer-video-1.0)
  edge_sdk_library(camera_gst VehicleTeleopSDK teleop
    src/adapters/camera_gst/camera_gst_adapter.cc)
  target_link_libraries(edge_camera_gst PUBLIC edge_teleop PkgConfig::GStreamer)
  install(FILES include/vehicle_edge/camera_gst_adapter.h
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/vehicle_edge COMPONENT teleop)
endif()

install(FILES include/vehicle_edge/state_cache.h include/vehicle_edge/config.h
  include/vehicle_edge/http_client.h include/vehicle_edge/auth_client.h
  DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/vehicle_edge COMPONENT auth)
install(FILES include/vehicle_edge/teleop_client.h include/vehicle_edge/media_demand.h
  include/vehicle_edge/media_service.h include/vehicle_edge/encoded_video.h
  include/vehicle_edge/control_receiver.h include/vehicle_edge/control_service.h
  DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/vehicle_edge COMPONENT teleop)
install(FILES include/vehicle_edge/data_client.h include/vehicle_edge/source_service.h
  include/vehicle_edge/durable_store.h include/vehicle_edge/health_service.h
  include/vehicle_edge/task_service.h include/vehicle_edge/data_service.h
  DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/vehicle_edge COMPONENT data)
install(DIRECTORY examples/teleop
  DESTINATION share/vehicle-edge/examples COMPONENT teleop)

foreach(_component auth teleop data)
  if(_component STREQUAL auth)
    set(_package VehicleAuthSDK)
  elseif(_component STREQUAL teleop)
    set(_package VehicleTeleopSDK)
  else()
    set(_package VehicleDataSDK)
  endif()
  install(EXPORT ${_package}Targets NAMESPACE VehicleEdge::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/${_package} COMPONENT ${_component})
  configure_package_config_file(cmake/${_package}Config.cmake.in
    "${CMAKE_CURRENT_BINARY_DIR}/${_package}Config.cmake"
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/${_package})
  write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/${_package}ConfigVersion.cmake"
    VERSION ${PROJECT_VERSION} COMPATIBILITY SameMajorVersion)
  install(FILES "${CMAKE_CURRENT_BINARY_DIR}/${_package}Config.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/${_package}ConfigVersion.cmake"
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/${_package} COMPONENT ${_component})
endforeach()
configure_package_config_file(cmake/VehicleEdgeSDKConfig.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/VehicleEdgeSDKConfig.cmake"
  INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/VehicleEdgeSDK)
write_basic_package_version_file(
  "${CMAKE_CURRENT_BINARY_DIR}/VehicleEdgeSDKConfigVersion.cmake"
  VERSION ${PROJECT_VERSION} COMPATIBILITY SameMajorVersion)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/VehicleEdgeSDKConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/VehicleEdgeSDKConfigVersion.cmake"
  DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/VehicleEdgeSDK COMPONENT data)

set(EDGE_CYBER_EXECUTABLE "" CACHE FILEPATH
  "Optional vehicle_telemetry executable built in the target Cyber environment")
if(EDGE_CYBER_EXECUTABLE)
  if(NOT IS_ABSOLUTE "${EDGE_CYBER_EXECUTABLE}" OR
     NOT EXISTS "${EDGE_CYBER_EXECUTABLE}" OR
     IS_DIRECTORY "${EDGE_CYBER_EXECUTABLE}")
    message(FATAL_ERROR "EDGE_CYBER_EXECUTABLE must be an existing absolute file")
  endif()
  install(PROGRAMS "${EDGE_CYBER_EXECUTABLE}" DESTINATION bin
    RENAME vehicle_telemetry COMPONENT native)
endif()
set(EDGE_CYBER_DATA_EXECUTABLE "" CACHE FILEPATH
  "Optional data-only vehicle_data executable built in the target Cyber environment")
if(EDGE_CYBER_DATA_EXECUTABLE)
  if(NOT IS_ABSOLUTE "${EDGE_CYBER_DATA_EXECUTABLE}" OR
     NOT EXISTS "${EDGE_CYBER_DATA_EXECUTABLE}" OR
     IS_DIRECTORY "${EDGE_CYBER_DATA_EXECUTABLE}")
    message(FATAL_ERROR "EDGE_CYBER_DATA_EXECUTABLE must be an existing absolute file")
  endif()
  install(PROGRAMS "${EDGE_CYBER_DATA_EXECUTABLE}" DESTINATION bin
    RENAME vehicle_data COMPONENT data)
endif()

option(EDGE_ENABLE_LIVEKIT "Build the native read-only LiveKit worker" OFF)
if(EDGE_ENABLE_LIVEKIT)
  include(cmake/LiveKitSDK.cmake)
  add_library(edge_media src/workers/media_backend.cc)
  target_link_libraries(edge_media PUBLIC edge_teleop LiveKit::livekit)
  target_compile_options(edge_media PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_executable(vehicle_media_worker src/workers/media_worker.cc)
  target_link_libraries(vehicle_media_worker PRIVATE edge_media)
  target_compile_options(vehicle_media_worker PRIVATE -Wall -Wextra -Wpedantic -Werror)
  set_target_properties(vehicle_media_worker PROPERTIES
    INSTALL_RPATH "$ORIGIN/../lib/vehicle-edge")
  install(TARGETS vehicle_media_worker RUNTIME DESTINATION bin COMPONENT teleop)
  install(FILES
    "${_livekit_cache}/${_livekit_name}/lib/liblivekit.so"
    "${_livekit_cache}/${_livekit_name}/lib/liblivekit_ffi.so"
    DESTINATION lib/vehicle-edge COMPONENT teleop)
  install(FILES "${_livekit_cache}/LICENSE"
    DESTINATION share/licenses/vehicle-edge-livekit COMPONENT teleop)
endif()

set(CPACK_GENERATOR TGZ)
set(CPACK_PACKAGE_NAME vehicle-edge-sdk)
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_ARCHIVE_COMPONENT_INSTALL ON)
set(CPACK_COMPONENTS_ALL auth teleop data)
if(EDGE_CYBER_EXECUTABLE)
  list(APPEND CPACK_COMPONENTS_ALL native)
  set(CPACK_COMPONENT_NATIVE_DEPENDS auth teleop data)
endif()
set(CPACK_COMPONENT_TELEOP_DEPENDS auth)
set(CPACK_COMPONENT_DATA_DEPENDS auth)
include(CPack)

include(CTest)
if(BUILD_TESTING)
  add_executable(data_test tests/data_test.cc)
  target_link_libraries(data_test PRIVATE edge_data)
  target_compile_options(data_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME data_test COMMAND data_test)
  add_executable(data_chain_client tests/data_chain_client.cc)
  target_link_libraries(data_chain_client PRIVATE edge_data)
  target_compile_options(data_chain_client PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_executable(control_receiver_test tests/control_receiver_test.cc)
  target_link_libraries(control_receiver_test PRIVATE edge_teleop)
  target_compile_options(control_receiver_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME control_receiver_test COMMAND control_receiver_test)
  add_executable(telemetry_test tests/telemetry_test.cc)
  target_link_libraries(telemetry_test PRIVATE edge_telemetry)
  target_compile_options(telemetry_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME telemetry_test COMMAND telemetry_test)
  add_executable(media_test tests/media_test.cc)
  target_link_libraries(media_test PRIVATE edge_telemetry)
  target_compile_options(media_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME media_test COMMAND media_test)
  add_executable(encoded_video_test tests/encoded_video_test.cc)
  target_link_libraries(encoded_video_test PRIVATE edge_teleop)
  target_compile_options(encoded_video_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME encoded_video_test COMMAND encoded_video_test)
  add_test(NAME sdk_delivery
    COMMAND "${CMAKE_COMMAND}"
      "-DEDGE_BINARY_DIR=${CMAKE_CURRENT_BINARY_DIR}"
      "-DEDGE_SOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}"
      "-DEDGE_CPACK=${CMAKE_CPACK_COMMAND}"
      "-DEDGE_CTEST=${CMAKE_CTEST_COMMAND}"
      "-DEDGE_LIBDIR=${CMAKE_INSTALL_LIBDIR}"
      "-DEDGE_JSONCPP_DIR=${jsoncpp_DIR}"
      "-DEDGE_GSTREAMER=${EDGE_ENABLE_GSTREAMER}"
      "-DEDGE_LIVEKIT=${EDGE_ENABLE_LIVEKIT}"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/sdk_delivery.cmake")
  set_tests_properties(sdk_delivery PROPERTIES TIMEOUT 120 RUN_SERIAL TRUE)
  if(EDGE_ENABLE_GSTREAMER)
    add_executable(camera_gst_test tests/camera_gst_test.cc)
    target_link_libraries(camera_gst_test PRIVATE edge_camera_gst)
    target_compile_options(camera_gst_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
    add_test(NAME camera_gst_test COMMAND camera_gst_test)
  endif()
  if(EDGE_ENABLE_LIVEKIT)
    add_test(NAME livekit_sdk_smoke COMMAND vehicle_media_worker --sdk-smoke)
    set_tests_properties(livekit_sdk_smoke PROPERTIES TIMEOUT 10)
    add_executable(livekit_integration_test tests/livekit_integration_test.cc)
    target_link_libraries(livekit_integration_test PRIVATE edge_media)
    target_compile_options(livekit_integration_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
    add_executable(control_chain_test tests/control_chain_test.cc)
    target_link_libraries(control_chain_test PRIVATE edge_media)
    target_compile_options(control_chain_test PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
endif()
