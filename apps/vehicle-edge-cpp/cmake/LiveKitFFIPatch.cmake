cmake_minimum_required(VERSION 3.20)

set(commit ede8ac53843a8fb91d6f4fb5629f5245f1758e38)
set(archive "${EDGE_FFI_WORK}/source.tar.gz")
set(source "${EDGE_FFI_WORK}/rust-sdks-${commit}")
file(MAKE_DIRECTORY "${EDGE_FFI_WORK}")
if(NOT EXISTS "${archive}")
  file(DOWNLOAD "https://codeload.github.com/livekit/rust-sdks/tar.gz/${commit}"
    "${archive}" TLS_VERIFY ON
    EXPECTED_HASH SHA256=9b9266fa6dd061f138f6386658e9082e46eca2c5c745d588653ad4968d3c6cfa)
endif()
file(SHA256 "${archive}" hash)
if(NOT hash STREQUAL "9b9266fa6dd061f138f6386658e9082e46eca2c5c745d588653ad4968d3c6cfa")
  message(FATAL_ERROR "Pinned Rust SDK source hash mismatch")
endif()
file(SHA256 "${EDGE_FFI_PATCH}" patch_hash)
if(EXISTS "${EDGE_FFI_WORK}/patched")
  file(READ "${EDGE_FFI_WORK}/patched" applied_hash)
endif()
if(NOT applied_hash STREQUAL patch_hash)
  if(EXISTS "${source}/target" AND NOT EXISTS "${EDGE_FFI_WORK}/target")
    file(RENAME "${source}/target" "${EDGE_FFI_WORK}/target")
  endif()
  file(REMOVE_RECURSE "${source}")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E tar xzf "${archive}"
    WORKING_DIRECTORY "${EDGE_FFI_WORK}" RESULT_VARIABLE status)
  if(NOT status EQUAL 0)
    message(FATAL_ERROR "Cannot extract pinned Rust SDK")
  endif()
  execute_process(COMMAND "${EDGE_PATCH}" -p1 -i "${EDGE_FFI_PATCH}"
    WORKING_DIRECTORY "${source}" RESULT_VARIABLE status)
  if(NOT status EQUAL 0)
    message(FATAL_ERROR "Cannot apply LiveKit authenticated sender fix")
  endif()
  file(WRITE "${EDGE_FFI_WORK}/patched" "${patch_hash}")
endif()
configure_file("${EDGE_FFI_SENDER}"
  "${source}/livekit/src/room/data_sender.rs" COPYONLY)
if(NOT EXISTS "${source}/target")
  file(MAKE_DIRECTORY "${EDGE_FFI_WORK}/target")
  execute_process(COMMAND "${CMAKE_COMMAND}" -E create_symlink
    "${EDGE_FFI_WORK}/target" "${source}/target" RESULT_VARIABLE status)
  if(NOT status EQUAL 0)
    message(FATAL_ERROR "Cannot link Rust build cache")
  endif()
endif()
function(submodule name url sha directory strip)
  set(tar "${EDGE_FFI_WORK}/${name}.tar.gz")
  if(NOT EXISTS "${tar}")
    file(DOWNLOAD "${url}" "${tar}" TLS_VERIFY ON EXPECTED_HASH "SHA256=${sha}")
  endif()
  file(SHA256 "${tar}" actual)
  if(NOT actual STREQUAL sha)
    message(FATAL_ERROR "Pinned ${name} source hash mismatch")
  endif()
  if(NOT EXISTS "${directory}/CMakeLists.txt" AND NOT EXISTS "${directory}/go.mod")
    file(MAKE_DIRECTORY "${directory}")
    execute_process(COMMAND tar xzf "${tar}" "--strip-components=${strip}"
      WORKING_DIRECTORY "${directory}" RESULT_VARIABLE status)
    if(NOT status EQUAL 0)
      message(FATAL_ERROR "Cannot extract pinned ${name}")
    endif()
  endif()
endfunction()
submodule(protocol
  "https://codeload.github.com/livekit/protocol/tar.gz/3fbe509850cb24aa90a0bc20134936698333dceb"
  56ab5173ba657ec84037a69679dfa8f1d7ec275913669ac5f5c5ddb878ba375a
  "${source}/livekit-protocol/protocol" 1)
submodule(libyuv
  "https://chromium.googlesource.com/libyuv/libyuv/+archive/917276084a49be726c90292ff0a6b0a3d571a6af.tar.gz"
  eaf0d447eb2ce4a5eab6e4a9af53a81f551bd36bca06e9441e28e6cb54b28e8d
  "${source}/yuv-sys/libyuv" 0)
execute_process(COMMAND "${CMAKE_COMMAND}" -E env --unset=MAKEFLAGS
  "CARGO_TARGET_DIR=${EDGE_FFI_WORK}/target"
  "${EDGE_CARGO}" build --quiet --locked --release -p livekit-ffi
  WORKING_DIRECTORY "${source}" RESULT_VARIABLE status)
if(NOT status EQUAL 0)
  message(FATAL_ERROR "Cannot build patched LiveKit FFI")
endif()
configure_file("${EDGE_FFI_WORK}/target/release/liblivekit_ffi.so"
  "${EDGE_FFI_LIBRARY}" COPYONLY)
