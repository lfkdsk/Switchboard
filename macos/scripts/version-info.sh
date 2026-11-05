#!/usr/bin/env bash
# Convert a release tag to Apple's monotonically ordered bundle versions.
#
#   v1.2.3       -> marketing 1.2.3, build 1.2.3
#   v1.2.3-rc2   -> marketing 1.2.3, build 1.2.3fc2
#
# Apple orders d < a < b < fc < the final build, so an RC can update to the
# corresponding stable release without inventing a fourth numeric component.
set -euo pipefail

input="${1:?usage: version-info.sh <vMAJOR.MINOR.PATCH[-alphaN|-betaN|-rcN]>}"
version="${input#v}"

if [[ ! "$version" =~ ^([0-9]{1,4})\.([0-9]{1,2})\.([0-9]{1,2})(-(alpha|beta|rc)([0-9]{1,3}))?$ ]]; then
  echo "unsupported release version: $input" >&2
  exit 1
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
stage="${BASH_REMATCH[5]:-}"
stage_number="${BASH_REMATCH[6]:-}"

for component in "$major" "$minor" "$patch"; do
  if [[ "$component" != "0" && "$component" == 0* ]]; then
    echo "release version components must not have leading zeroes: $input" >&2
    exit 1
  fi
done

marketing_version="$major.$minor.$patch"
build_version="$marketing_version"
if [ -n "$stage" ]; then
  stage_number_value=$((10#$stage_number))
  if [ "$stage_number_value" -lt 1 ] || [ "$stage_number_value" -gt 255 ]; then
    echo "prerelease number must be between 1 and 255: $input" >&2
    exit 1
  fi
  case "$stage" in
    alpha) apple_stage="a" ;;
    beta) apple_stage="b" ;;
    rc) apple_stage="fc" ;;
  esac
  build_version="$build_version$apple_stage$stage_number_value"
fi

echo "version=$version"
echo "marketing_version=$marketing_version"
echo "build_version=$build_version"
