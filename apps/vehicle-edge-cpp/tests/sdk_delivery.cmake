cmake_minimum_required(VERSION 3.16)

function(run)
  execute_process(COMMAND ${ARGV}
    RESULT_VARIABLE status OUTPUT_VARIABLE output ERROR_VARIABLE error)
  if(NOT "${status}" STREQUAL "0")
    message(FATAL_ERROR "SDK delivery command failed (${status}): ${ARGV}\n${output}\n${error}")
  endif()
endfunction()

string(RANDOM LENGTH 12 ALPHABET 0123456789abcdef suffix)
set(work "${EDGE_BINARY_DIR}/sdk-delivery/${suffix}")
file(MAKE_DIRECTORY "${work}/prefix")

run("${EDGE_CPACK}" --config "${EDGE_BINARY_DIR}/CPackConfig.cmake"
  -B "${work}/packages")
foreach(component auth teleop)
  file(GLOB archives "${work}/packages/*-${component}.tar.gz")
  list(LENGTH archives count)
  if(NOT count EQUAL 1)
    message(FATAL_ERROR "Expected one ${component} SDK archive, got ${count}")
  endif()
  list(GET archives 0 archive)
  run("${CMAKE_COMMAND}" -E chdir "${work}/prefix"
    "${CMAKE_COMMAND}" -E tar xzf "${archive}")
endforeach()

if(EXISTS "${work}/prefix/include/vehicle_edge/data_client.h" OR
   EXISTS "${work}/prefix/${EDGE_LIBDIR}/libedge_data.a" OR
   EXISTS "${work}/prefix/${EDGE_LIBDIR}/cmake/VehicleDataSDK")
  message(FATAL_ERROR "Two-SDK delivery unexpectedly includes operations data")
endif()

run("${CMAKE_COMMAND}" -S "${EDGE_SOURCE_DIR}/tests/teleop_consumer"
  -B "${work}/consumer" "-DCMAKE_PREFIX_PATH=${work}/prefix"
  "-DCONSUMER_CAMERA_GST=${EDGE_GSTREAMER}"
  "-Djsoncpp_DIR=${EDGE_JSONCPP_DIR}"
  -DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF)
run("${CMAKE_COMMAND}" --build "${work}/consumer" --parallel 2)
# Works with CTest versions predating --test-dir.
run("${CMAKE_COMMAND}" -E chdir "${work}/consumer"
  "${EDGE_CTEST}" --output-on-failure)

run("${CMAKE_COMMAND}" -S "${work}/prefix/share/vehicle-edge/examples/teleop"
  -B "${work}/example" "-DCMAKE_PREFIX_PATH=${work}/prefix"
  "-Djsoncpp_DIR=${EDGE_JSONCPP_DIR}"
  -DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF)
run("${CMAKE_COMMAND}" --build "${work}/example" --parallel 2)
run("${work}/example/teleop_simulation" --help)

if(EDGE_LIVEKIT)
  run("${work}/prefix/bin/vehicle_media_worker" --sdk-smoke)
endif()
message(STATUS "Auth + Teleop archives, standalone consumer and shipped example verified: ${work}")

file(MAKE_DIRECTORY "${work}/data-prefix")
foreach(component auth data)
  file(GLOB archives "${work}/packages/*-${component}.tar.gz")
  list(LENGTH archives count)
  if(NOT count EQUAL 1)
    message(FATAL_ERROR "Expected one ${component} SDK archive, got ${count}")
  endif()
  list(GET archives 0 archive)
  run("${CMAKE_COMMAND}" -E chdir "${work}/data-prefix"
    "${CMAKE_COMMAND}" -E tar xzf "${archive}")
endforeach()
if(EXISTS "${work}/data-prefix/include/vehicle_edge/teleop_client.h" OR
   EXISTS "${work}/data-prefix/${EDGE_LIBDIR}/libedge_teleop.a" OR
   EXISTS "${work}/data-prefix/${EDGE_LIBDIR}/cmake/VehicleTeleopSDK" OR
   EXISTS "${work}/data-prefix/bin/vehicle_media_worker")
  message(FATAL_ERROR "Auth + Data delivery unexpectedly includes Teleop/media")
endif()
run("${CMAKE_COMMAND}" -S "${EDGE_SOURCE_DIR}/tests/data_consumer"
  -B "${work}/data-consumer" "-DCMAKE_PREFIX_PATH=${work}/data-prefix"
  "-Djsoncpp_DIR=${EDGE_JSONCPP_DIR}" -DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF)
run("${CMAKE_COMMAND}" --build "${work}/data-consumer" --parallel 2)
run("${CMAKE_COMMAND}" -E chdir "${work}/data-consumer"
  "${EDGE_CTEST}" --output-on-failure)
message(STATUS "Auth + Data archives and standalone durable consumer verified: ${work}")
