"""Validate synthetic Gateway and preview outputs against published JSON Schemas."""

import json
import pathlib
import sys

from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    schemas = {}
    for name in ("vehicle-telemetry.schema.json", "vehicle-operations.schema.json"):
        schemas[name] = json.loads((root / "api/schemas" / name).read_text())
        Draft202012Validator.check_schema(schemas[name])
    registry = Registry().with_resources(
        (name, Resource.from_contents(schema)) for name, schema in schemas.items()
    )
    telemetry = Draft202012Validator(
        schemas["vehicle-telemetry.schema.json"], registry=registry
    )
    operations = Draft202012Validator(
        schemas["vehicle-operations.schema.json"], registry=registry
    )
    corpus = json.loads(pathlib.Path(sys.argv[1]).read_text())
    for scenario in corpus:
        try:
            operations.validate(scenario["operations"])
            if scenario["entry"]["state"] is not None:
                telemetry.validate(scenario["entry"]["state"])
        except ValidationError as error:
            # Add the scenario name without converting a validation error to success.
            raise RuntimeError(f"Schema mismatch: {scenario['name']}") from error
    print(f"Published JSON Schemas: {len(corpus)} Gateway/preview snapshots passed")


if __name__ == "__main__":
    main()
